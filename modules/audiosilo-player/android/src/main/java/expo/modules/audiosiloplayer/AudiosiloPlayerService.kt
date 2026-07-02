package expo.modules.audiosiloplayer

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.io.File
import java.util.concurrent.Executors

// Custom session commands for the 30s skip buttons. They must be CUSTOM actions (not the
// standard COMMAND_SEEK_BACK/FORWARD, which map to legacy ACTION_REWIND/FAST_FORWARD that
// the modern Android media UI does NOT render) so the buttons actually appear.
private const val CMD_SEEK_BACK = "audiosilo.SEEK_BACK"
private const val CMD_SEEK_FORWARD = "audiosilo.SEEK_FORWARD"

/**
 * Shared auth headers for streaming + artwork. They are identical for every track
 * in a book (a single session bearer token), so the module sets them once per load
 * and the data source reads them at request time.
 */
object AuthHolder {
  @Volatile
  var headers: Map<String, String> = emptyMap()
}

/**
 * User-configurable playback tunables, shared from the Expo module's `setConfig` to the
 * player. Just the auto-rewind window, read live by [AudiobookPlayer.play] so a resume
 * from anywhere (the lock screen included) rewinds by the current Settings value.
 */
object PlayerConfig {
  @Volatile var autoRewindMaxMs: Long = 0
}

/** Lock-screen 30s skip increment (both directions). Fixed (matches the ICON_SKIP_*_30
 * glyphs); the in-app controller still uses the user's configurable intervals. */
private const val SKIP_INCREMENT_MS = 30_000L

/**
 * Wraps the ExoPlayer so audiobook behavior applies no matter where a command
 * originates (lock screen, notification, headset, or the JS bridge - all route through
 * the session's player):
 *  - **Auto-rewind on resume** lives in [play] (not the JS bridge), so resuming from the
 *    lock screen rewinds too. [prepare] resets the baseline so a freshly-loaded book
 *    never inherits the previous one's pause time.
 *  - **Prev/next** are exposed only when there's more than one item (chapter clips or a
 *    multi-file book) → the lock screen gets prev/next-chapter buttons. With a single
 *    item (a chapterless single-file book) they're hidden so a tap can't "restart the
 *    only book".
 */
private class AudiobookPlayer(player: Player) : ForwardingPlayer(player) {
  private var pausedAt: Long = 0L

  override fun getAvailableCommands(): Player.Commands {
    val base = super.getAvailableCommands()
    if (mediaItemCount > 1) return base
    return base.buildUpon()
      .removeAll(
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
      )
      .build()
  }

  override fun prepare() {
    pausedAt = 0L // a new load: don't rewind against the previous book's pause
    super.prepare()
  }

  override fun play() {
    val maxMs = PlayerConfig.autoRewindMaxMs
    if (maxMs > 0 && pausedAt > 0L) {
      val rewind = minOf(maxMs, System.currentTimeMillis() - pausedAt)
      if (rewind > 500) seekTo(maxOf(0L, currentPosition - rewind))
    }
    pausedAt = 0L
    super.play()
  }

  override fun pause() {
    pausedAt = System.currentTimeMillis()
    super.pause()
  }
}

/**
 * Hosts the ExoPlayer + MediaSession so playback survives in the background. Media3
 * renders the media notification / lock-screen controls and runs the foreground
 * service automatically. The Expo module drives it through a MediaController.
 *
 * Lock screen (Audible-parity): a chapter-relative scrubber + prev/next-chapter buttons
 * (chapters are clipped media items, built by [AudiosiloPlayerModule]) + 30s skip buttons
 * (predefined Media3 icons) + the app logo as the notification small icon.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class AudiosiloPlayerService : MediaSessionService() {
  private var mediaSession: MediaSession? = null

  override fun onCreate() {
    super.onCreate()

    val httpFactory = DefaultHttpDataSource.Factory()
    val upstream = DataSource.Factory {
      val ds = httpFactory.createDataSource()
      AuthHolder.headers.forEach { (key, value) -> ds.setRequestProperty(key, value) }
      ds
    }
    // Cache streamed bytes so the repeated opens that chapter clips make over the SAME
    // single-file m4b reuse already-downloaded data + the parsed container header,
    // keeping chapter transitions gapless. Local (downloaded) file:// sources bypass
    // this - DefaultDataSource routes them to the file data source, not the http upstream.
    val cacheFactory = CacheDataSource.Factory()
      .setCache(getCache(this))
      .setUpstreamDataSourceFactory(upstream)
      .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    val dataSourceFactory = DefaultDataSource.Factory(this, cacheFactory)
    val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)

    val audioAttributes = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
      .build()

    val exoPlayer = ExoPlayer.Builder(this)
      .setMediaSourceFactory(mediaSourceFactory)
      .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
      .setHandleAudioBecomingNoisy(true)
      .setSeekBackIncrementMs(SKIP_INCREMENT_MS)
      .setSeekForwardIncrementMs(SKIP_INCREMENT_MS)
      .build()
    val player = AudiobookPlayer(exoPlayer)

    // Authenticated artwork loader (uses the same headers as the stream).
    val bitmapLoader = CacheBitmapLoader(
      DataSourceBitmapLoader(
        MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor()),
        dataSourceFactory,
      ),
    )

    // App logo as the notification small icon (Media3's default is a generic glyph).
    // Must be a white/transparent silhouette - the system tints it.
    setMediaNotificationProvider(
      DefaultMediaNotificationProvider.Builder(this).build().apply {
        setSmallIcon(R.drawable.ic_notification)
      },
    )

    mediaSession = MediaSession.Builder(this, player)
      .setBitmapLoader(bitmapLoader)
      .setCallback(MediaCallback)
      // Use setCustomLayout (NOT setMediaButtonPreferences): the slot-based preferences
      // capped the notification at 3 actions on 1.5.1 (it drops the secondary slots -
      // verified via dumpsys, actions=3). setCustomLayout makes the provider build
      // [prev, play/pause, next] (auto, from command availability) + the custom skip
      // buttons → all 5 actions, alongside the draggable chapter scrubber. (dumpsys: actions=5)
      .setCustomLayout(mediaButtons())
      .build()
  }

  /**
   * The 30s skip buttons for the notification's custom layout. Media3's notification
   * provider builds the action row as **standard [prev, play/pause, next]** (auto-added
   * from the player's available seek-to-prev/next commands - present for a chaptered book,
   * absent for a single-item/chapterless book) **plus the CUSTOM-command buttons** from the
   * custom layout. So we only declare the two skip buttons here and let prev/next-chapter
   * fill in automatically → the full `[prev] [play] [next] [back-30] [fwd-30]` row.
   *
   * They MUST be custom session commands (see [MediaCallback]); the standard
   * COMMAND_SEEK_BACK/FORWARD map to the legacy ACTION_REWIND/FAST_FORWARD the modern media
   * UI ignores. Predefined `ICON_SKIP_*_30` icons render without an app-shipped drawable.
   */
  private fun mediaButtons(): List<CommandButton> = listOf(
    CommandButton.Builder(CommandButton.ICON_SKIP_BACK_30)
      .setSessionCommand(SessionCommand(CMD_SEEK_BACK, Bundle.EMPTY))
      .setDisplayName("Back 30 seconds")
      .build(),
    CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30)
      .setSessionCommand(SessionCommand(CMD_SEEK_FORWARD, Bundle.EMPTY))
      .setDisplayName("Forward 30 seconds")
      .build(),
  )

  /**
   * Grants the custom skip commands to connecting controllers (so the buttons are enabled)
   * and runs them as the player's own 30s seek (clip-bounded → stays within the chapter,
   * which is fine; prev/next chapter cross boundaries).
   */
  private object MediaCallback : MediaSession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): MediaSession.ConnectionResult {
      val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
        .add(SessionCommand(CMD_SEEK_BACK, Bundle.EMPTY))
        .add(SessionCommand(CMD_SEEK_FORWARD, Bundle.EMPTY))
        .build()
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(sessionCommands)
        .build()
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      when (customCommand.customAction) {
        CMD_SEEK_BACK -> session.player.seekBack()
        CMD_SEEK_FORWARD -> session.player.seekForward()
      }
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The user swiped the app away from recents. Android usually keeps the (now
    // task-less) process cached, so the next launch is a warm resume on the last
    // route - and that restored screen renders blank on the new Activity. Record the
    // dismissal so the JS layer can reset to Home on the next foreground, matching the
    // iOS cold-start behavior the user expects. A plain app-switch never lands here.
    getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_TASK_REMOVED, true)
      .apply()
    val player = mediaSession?.player
    if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
      stopSelf()
    }
  }

  override fun onDestroy() {
    mediaSession?.run {
      player.release()
      release()
    }
    mediaSession = null
    // The cache is a process-lifetime singleton (a SimpleCache instance owns its folder);
    // don't release it here, or a service restart couldn't reopen the same folder.
    super.onDestroy()
  }

  companion object {
    /** Shared prefs + key used to hand the "task swiped from recents" signal to the
     * module (read+cleared by `consumeTaskRemoved`). The service and module live in
     * the same process; prefs are the simplest durable channel between them. */
    const val PREFS = "audiosilo.player"
    const val KEY_TASK_REMOVED = "task_removed"

    @Volatile private var mediaCache: SimpleCache? = null

    /** Process-wide streaming cache (64 MB LRU). One SimpleCache instance may own a
     * folder at a time, so it's a guarded singleton shared across service restarts. */
    @Synchronized
    private fun getCache(context: Context): SimpleCache {
      return mediaCache ?: SimpleCache(
        File(context.cacheDir, "media3"),
        LeastRecentlyUsedCacheEvictor(64L * 1024 * 1024),
        StandaloneDatabaseProvider(context.applicationContext),
      ).also { mediaCache = it }
    }
  }
}
