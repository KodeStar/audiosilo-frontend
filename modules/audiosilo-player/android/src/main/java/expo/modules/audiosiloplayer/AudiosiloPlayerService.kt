package expo.modules.audiosiloplayer

import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.MoreExecutors
import java.util.concurrent.Executors

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

/**
 * Wraps the ExoPlayer so audiobook behavior applies no matter where a command
 * originates (lock screen, notification, headset, or the JS bridge — all route through
 * the session's player):
 *  - **Auto-rewind on resume** lives in [play] (not the JS bridge), so resuming from the
 *    lock screen rewinds too. [prepare] resets the baseline so a freshly-loaded book
 *    never inherits the previous one's pause time.
 *  - **Hides previous/next-track** from controllers, so the lock screen can't "restart
 *    the book" via a previous-track button. In-app chapter jumps use seek-to-media-item,
 *    which is unaffected.
 */
private class AudiobookPlayer(player: Player) : ForwardingPlayer(player) {
  private var pausedAt: Long = 0L

  override fun getAvailableCommands(): Player.Commands =
    super.getAvailableCommands().buildUpon()
      .removeAll(
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
      )
      .build()

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
    val dataSourceFactory = DefaultDataSource.Factory(this, upstream)
    val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)

    val audioAttributes = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
      .build()

    val exoPlayer = ExoPlayer.Builder(this)
      .setMediaSourceFactory(mediaSourceFactory)
      .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
      .setHandleAudioBecomingNoisy(true)
      .build()
    val player = AudiobookPlayer(exoPlayer)

    // Authenticated artwork loader (uses the same headers as the stream).
    val bitmapLoader = CacheBitmapLoader(
      DataSourceBitmapLoader(
        MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor()),
        dataSourceFactory,
      ),
    )

    mediaSession = MediaSession.Builder(this, player)
      .setBitmapLoader(bitmapLoader)
      .setCallback(NotificationControlsCallback)
      .build()
  }

  /**
   * Restricts what the system's lock-screen / notification media UI can do. Media3 derives
   * that UI from the **media-notification controller**'s available commands, so removing
   * the seek-to-position commands there hides the scrubber — a stray tap on a whole-book
   * scrub bar can otherwise fling you to a random place, with no skip buttons to recover
   * (this platform's media UI won't render Media3's icon-less skip buttons). The result is
   * a deliberate play/pause-only lock screen. Every OTHER controller — notably our own
   * in-app MediaController — keeps full commands, so the app's seek bar still works.
   */
  private object NotificationControlsCallback : MediaSession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): MediaSession.ConnectionResult {
      if (!session.isMediaNotificationController(controller)) {
        return MediaSession.ConnectionResult.AcceptedResultBuilder(session).build()
      }
      val commands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
        .remove(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
        .remove(Player.COMMAND_SEEK_TO_DEFAULT_POSITION)
        .remove(Player.COMMAND_SEEK_BACK)
        .remove(Player.COMMAND_SEEK_FORWARD)
        .build()
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailablePlayerCommands(commands)
        .build()
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

  override fun onTaskRemoved(rootIntent: Intent?) {
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
    super.onDestroy()
  }
}
