package expo.modules.audiosiloplayer

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackParameters
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
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSession.MediaItemsWithStartPosition
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.google.common.util.concurrent.SettableFuture
import expo.modules.audiosiloplayer.effects.AudioEffects
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * User-configurable playback tunables, shared from the Expo module's `setConfig` to the
 * player: the auto-rewind window (read live by [AudiobookPlayer.play] so a resume from
 * anywhere, the lock screen included, rewinds by the current Settings value) and the
 * skip intervals (read live by [AudiobookPlayer.seekBack]/[AudiobookPlayer.seekForward]).
 */
object PlayerConfig {
  @Volatile var autoRewindMaxMs: Long = 0
  // Skip amounts (ms). The seek honors these immediately; the notification glyphs
  // (nearest predefined ICON_SKIP_*) are chosen when the layout is built at start.
  @Volatile var jumpForwardMs: Long = 30_000
  @Volatile var jumpBackwardMs: Long = 15_000
}

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
 * Hosts the ExoPlayer + MediaSession so playback survives in the background. Media3
 * renders the media notification / lock-screen controls and runs the foreground
 * service automatically. The Expo module drives it through a MediaController.
 *
 * Lock screen (Audible-parity): a chapter-relative scrubber + prev/next-chapter buttons
 * (chapters are clipped media items, see [MediaItems]) + 30s skip buttons (predefined Media3
 * icons) + the app logo as the notification small icon.
 *
 * Phase 6: a [MediaLibraryService] so Android Auto can browse (the car snapshot JS writes, see
 * [CarBrowseTree]) and play; the session player is the same [AudiobookPlayer], so the lock
 * screen behaves exactly as before. It also reports remote moves / speed changes / bookmark
 * presses to the module ([PlayerBridge]) and wires Smart Speed + Voice Boost ([AudioEffects]).
 */
@androidx.annotation.OptIn(UnstableApi::class)
class AudiosiloPlayerService : MediaLibraryService() {
  private var mediaSession: MediaLibrarySession? = null
  private var exoPlayer: ExoPlayer? = null
  internal var player: AudiobookPlayer? = null
    private set
  /** Single-thread artwork loader executor; retained so onDestroy can shut it down. */
  private var bitmapExecutor: ExecutorService? = null
  private val handler = Handler(Looper.getMainLooper())

  /** Android Auto / Automotive controllers connected right now (the fallback car signal). */
  private val carControllers = HashSet<MediaSession.ControllerInfo>()
  private var carMonitor: CarConnectionMonitor? = null

  /** A car play JS must start, waiting for the module's next `load` (see [playFromCar]). */
  private var pendingPlay: SettableFuture<MediaItemsWithStartPosition>? = null
  private val pendingTimeout = Runnable { failPendingPlay() }

  /** The bookmark button shows "filled" for a moment after a press. */
  private var bookmarkFilled = false
  private val bookmarkUnfill = Runnable {
    bookmarkFilled = false
    mediaSession?.setCustomLayout(mediaButtons())
  }

  override fun onCreate() {
    super.onCreate()
    CarSnapshotStore.init(this)

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

    // The renderers factory installs the Smart Speed + Voice Boost audio processor chain.
    val exo = ExoPlayer.Builder(this, AudioEffects.renderersFactory(this))
      .setMediaSourceFactory(mediaSourceFactory)
      .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
      .setHandleAudioBecomingNoisy(true)
      .build()
    // A service started without JS (the car, playback resumption) applies the listener's last
    // switches; the module's setConfig re-sends them whenever JS runs.
    val (smart, boost) = AudioEffects.load(this)
    AudioEffects.apply(exo, smart, boost)
    exoPlayer = exo
    exo.addListener(object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        // A book playing with no JS (started from the car, or resumed) must still save its
        // progress: boot JS, which adopts the loaded book (store `adoptLoaded`).
        if (isPlaying) needJs() else maybeReleaseJs()
      }
    })
    val audiobookPlayer = AudiobookPlayer(exo, PlayerHooks())
    player = audiobookPlayer

    // Authenticated artwork loader (uses the same headers as the stream). Retain the
    // executor so onDestroy can shut it down - an unmanaged newSingleThreadExecutor leaks
    // its non-daemon thread when the service dies.
    val executor = Executors.newSingleThreadExecutor()
    bitmapExecutor = executor
    val bitmapLoader = CacheBitmapLoader(
      DataSourceBitmapLoader(MoreExecutors.listeningDecorator(executor), dataSourceFactory),
    )

    // App logo as the notification small icon (Media3's default is a generic glyph).
    // Must be a white/transparent silhouette - the system tints it.
    setMediaNotificationProvider(
      NotificationProvider(this).apply { setSmallIcon(R.drawable.ic_notification) },
    )

    mediaSession = MediaLibrarySession.Builder(this, audiobookPlayer, LibraryCallback(this))
      .setBitmapLoader(bitmapLoader)
      // Use setCustomLayout (NOT setMediaButtonPreferences): the slot-based preferences
      // capped the notification at 3 actions on 1.5.1 (it drops the secondary slots -
      // verified via dumpsys, actions=3). setCustomLayout makes the provider build
      // [prev, play/pause, next] (auto, from command availability) + the custom skip
      // buttons -> all 5 actions, alongside the draggable chapter scrubber. (dumpsys: actions=5)
      .setCustomLayout(mediaButtons())
      .build()

    carMonitor = CarConnectionMonitor(this) { updateCarConnection() }.also { it.start() }
    PlayerBridge.service = this
  }

  /** The car snapshot (null until JS wrote one). */
  internal fun snapshot(): CarSnapshot? = CarSnapshotStore.get(this)

  /**
   * The custom buttons. Media3's notification provider builds the action row as **standard
   * [prev, play/pause, next]** (auto-added from the player's available seek-to-prev/next
   * commands - present for a chaptered book, absent for a single-item/chapterless book)
   * **plus the CUSTOM-command buttons** from the custom layout. So we only declare the two
   * skip buttons and let prev/next-chapter fill in -> the full
   * `[prev] [play] [next] [back-30] [fwd-30]` row.
   *
   * They MUST be custom session commands (see [LibraryCallback]); the standard
   * COMMAND_SEEK_BACK/FORWARD map to the legacy ACTION_REWIND/FAST_FORWARD the modern media
   * UI ignores. Predefined `ICON_SKIP_*_30` icons render without an app-shipped drawable.
   *
   * The bookmark comes THIRD: System UI (API 33+) shows play, prev, next and only the first
   * two custom actions, so the phone keeps exactly today's row, while Android Auto lists every
   * custom action (the bookmark in its overflow). [NotificationProvider] leaves it out of the
   * notification's own actions so `dumpsys notification` stays at actions=5.
   */
  private fun mediaButtons(): List<CommandButton> {
    val labels = snapshot()?.labels
    return listOf(
      CommandButton.Builder(skipIcon(PlayerConfig.jumpBackwardMs, forward = false))
        .setSessionCommand(SessionCommand(CMD_SEEK_BACK, Bundle.EMPTY))
        .setDisplayName("Back ${PlayerConfig.jumpBackwardMs / 1000} seconds")
        .build(),
      CommandButton.Builder(skipIcon(PlayerConfig.jumpForwardMs, forward = true))
        .setSessionCommand(SessionCommand(CMD_SEEK_FORWARD, Bundle.EMPTY))
        .setDisplayName("Forward ${PlayerConfig.jumpForwardMs / 1000} seconds")
        .build(),
      CommandButton.Builder(
        if (bookmarkFilled) CommandButton.ICON_BOOKMARK_FILLED else CommandButton.ICON_BOOKMARK_UNFILLED,
      )
        .setSessionCommand(SessionCommand(CMD_BOOKMARK, Bundle.EMPTY))
        // JS localizes the labels through the snapshot; English until the first snapshot.
        .setDisplayName(
          (if (bookmarkFilled) labels?.bookmarkSaved else labels?.bookmark)?.ifEmpty { null }
            ?: if (bookmarkFilled) "Bookmark saved" else "Bookmark",
        )
        .build(),
    )
  }

  /** Nearest predefined Media3 skip glyph for a configured interval. Media3 ships only
   * 5/10/15/30s icons, so an off-scale value shows the closest one; the actual seek uses
   * the exact configured amount (see [AudiobookPlayer.seekBack]/[AudiobookPlayer.seekForward]). */
  private fun skipIcon(ms: Long, forward: Boolean): Int {
    val sec = ms / 1000
    return when {
      sec <= 7 -> if (forward) CommandButton.ICON_SKIP_FORWARD_5 else CommandButton.ICON_SKIP_BACK_5
      sec <= 12 -> if (forward) CommandButton.ICON_SKIP_FORWARD_10 else CommandButton.ICON_SKIP_BACK_10
      sec <= 22 -> if (forward) CommandButton.ICON_SKIP_FORWARD_15 else CommandButton.ICON_SKIP_BACK_15
      else -> if (forward) CommandButton.ICON_SKIP_FORWARD_30 else CommandButton.ICON_SKIP_BACK_30
    }
  }

  /** Who asked for the Player call in progress, and where remote moves go. */
  private inner class PlayerHooks : AudiobookPlayerHooks {
    override fun isRemoteRequest(): Boolean {
      val c = mediaSession?.controllerForCurrentRequest ?: return false
      return !PlayerBridge.isAppController(c)
    }

    override fun onRemoteMove() {
      val (fileIndex, position) = currentFilePosition() ?: return
      PlayerBridge.sink?.remoteMove(fileIndex, position)
    }

    override fun onRemoteRate(rate: Float) {
      PlayerBridge.sink?.rateChange(rate.toDouble())
    }
  }

  /** Where the player is, in FILE coordinates (from the current item's extras). */
  private fun currentFilePosition(): Pair<Int, Double>? {
    val p = player ?: return null
    if (p.mediaItemCount == 0) return null
    val entry = MediaItems.entryOf(p.currentMediaItem)
    val sec = p.currentPosition / 1000.0
    return if (entry != null) Pair(entry.fileIndex, entry.startInFile + sec) else Pair(p.currentMediaItemIndex, sec)
  }

  // ---- Effects ---------------------------------------------------------------------------

  internal fun applyEffects(smartSpeed: Boolean, voiceBoost: Boolean) {
    val exo = exoPlayer ?: return
    AudioEffects.apply(exo, smartSpeed, voiceBoost)
    AudioEffects.save(this, smartSpeed, voiceBoost)
  }

  // ---- Bookmarks -------------------------------------------------------------------------

  /** The bookmark button: JS saves it when it listens, else it waits in the pending list (and
   * JS boots to drain it). The icon shows "filled" for ~2 s either way. */
  internal fun onBookmarkPressed() {
    val p = player ?: return
    val (fileIndex, position) = currentFilePosition() ?: return
    val sink = PlayerBridge.sink
    if (sink != null && sink.observingBookmarks) {
      sink.remoteBookmark(fileIndex, position)
    } else {
      val book = MediaItems.bookOf(p.currentMediaItem) ?: return // can't name the book: drop it
      PendingBookmarks.append(this, book, fileIndex, position)
      needJs()
    }
    bookmarkFilled = true
    mediaSession?.setCustomLayout(mediaButtons())
    handler.removeCallbacks(bookmarkUnfill)
    handler.postDelayed(bookmarkUnfill, 2_000)
  }

  // ---- Android Auto ----------------------------------------------------------------------

  internal fun onControllerConnected(controller: MediaSession.ControllerInfo) {
    if (isCarController(controller)) {
      carControllers.add(controller)
      updateCarConnection()
    }
  }

  internal fun onControllerDisconnected(controller: MediaSession.ControllerInfo) {
    if (carControllers.remove(controller)) updateCarConnection()
  }

  /** Android Auto's phone app (projection; also the DHU) or Automotive's media center. Media3's
   * own `isAutoCompanionController`/`isAutomotiveController` check the same packages but only
   * for LEGACY controllers; a package check also covers a future Media3 controller. */
  private fun isCarController(c: MediaSession.ControllerInfo) = c.packageName in CAR_PACKAGES

  /** Connected = the car connection provider says so; when it can't be read, any connected Auto
   * controller. Emits `onCarConnection` on a change; JS refreshes the snapshot on connect. */
  private fun updateCarConnection() {
    val connected = carMonitor?.state ?: carControllers.isNotEmpty()
    if (connected == PlayerBridge.carConnected) return
    PlayerBridge.carConnected = connected
    PlayerBridge.sink?.carConnection(connected)
    if (connected) needJs() else maybeReleaseJs()
  }

  /** The snapshot changed (`setCarSnapshot`): refresh what the car shows, and the bookmark
   * button's label. */
  internal fun onSnapshotChanged() {
    val session = mediaSession ?: return
    val snapshot = snapshot()
    session.notifyChildrenChanged(CarBrowseTree.ROOT, snapshot?.tabs?.size ?: 0, null)
    snapshot?.tabs?.forEach { session.notifyChildrenChanged(CarBrowseTree.tabId(it), it.items.size, null) }
    session.setCustomLayout(mediaButtons())
  }

  /** Lets the browsing app (Android Auto's package) open a cover's content URI. */
  internal fun grantArtwork(browser: MediaSession.ControllerInfo, uri: Uri) {
    try {
      grantUriPermission(browser.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    } catch (e: Exception) {
      Log.w(TAG, "Could not grant artwork to ${browser.packageName}", e)
    }
  }

  /**
   * The car (or a resumption) asked to play a snapshot book.
   *  - JS not listening and the book is downloaded (has a play spec): start it now, from the
   *    spec; JS boots once it plays and adopts it (`getLoadedBook`).
   *  - Otherwise JS starts it (`onCarPlayRequest`, queued until JS listens; JS boots when
   *    needed). The returned future completes when the module's next `load` arrives (with the
   *    queue JS just loaded), or fails after ~10 s with the snapshot's "unavailable" label.
   *    While JS runs, even a downloaded book goes through JS: JS may hold another book as
   *    `nowPlaying`, and swapping the engine under it would save one book's place as another's.
   */
  internal fun playFromCar(id: String, requirePlaySpec: Boolean): ListenableFuture<MediaItemsWithStartPosition> {
    val snapshot = snapshot()
    val item = snapshot?.find(id)
    val spec = item?.play
    if (item == null || (requirePlaySpec && spec == null)) {
      sendUnavailable()
      return Futures.immediateFailedFuture(UnsupportedOperationException("Unknown car item"))
    }
    if (spec != null && !PlayerBridge.jsListening) {
      val queue = MediaItems.buildQueue(spec.tracks, spec.clips, spec.book, spec.startIndex, spec.positionInTrack)
      // Every track of a play spec is a local file: no auth headers.
      AuthHolder.headers = emptyMap()
      player?.internal { player?.setPlaybackParameters(PlaybackParameters(spec.rate.toFloat(), 1.0f)) }
      return Futures.immediateFuture(MediaItemsWithStartPosition(queue.items, queue.index, queue.positionMs))
    }
    failPendingPlay(notify = false)
    val future = SettableFuture.create<MediaItemsWithStartPosition>()
    pendingPlay = future
    handler.postDelayed(pendingTimeout, CAR_PLAY_TIMEOUT_MS)
    PlayerBridge.requestCarPlay(id)
    needJs()
    return future
  }

  /** The module's `load` arrived (the app's controller set a queue). Completes a pending car
   * play with that queue; the identical re-set Media3 then makes is absorbed by the player. */
  internal fun onAppLoad() {
    if (pendingPlay == null) return
    // Posted: the app's items are applied right after this callback returns.
    handler.post {
      val future = pendingPlay ?: return@post
      val p = player ?: return@post
      pendingPlay = null
      handler.removeCallbacks(pendingTimeout)
      val items = (0 until p.mediaItemCount).map { p.getMediaItemAt(it) }
      if (items.isEmpty()) {
        future.setException(IllegalStateException("Nothing loaded"))
        return@post
      }
      p.absorbIdenticalSet = true
      future.set(MediaItemsWithStartPosition(items, p.currentMediaItemIndex, p.currentPosition))
      // Media3 applies the result on this looper (at once, or posted ahead of this): clear the
      // flag after it, so a later identical load of the app's (a retry) is never skipped.
      handler.post { player?.absorbIdenticalSet = false }
    }
  }

  private fun failPendingPlay(notify: Boolean = true) {
    handler.removeCallbacks(pendingTimeout)
    val future = pendingPlay ?: return
    pendingPlay = null
    PlayerBridge.pendingCarPlayId = null
    future.setException(IllegalStateException("The car play request timed out"))
    if (notify) sendUnavailable()
  }

  /** An error Android Auto shows (the platform session's error state), in the listener's
   * language (the snapshot's label). */
  private fun sendUnavailable() {
    val label = snapshot()?.labels?.unavailable?.ifEmpty { null } ?: return
    try {
      mediaSession?.sendError(SessionError(SessionError.ERROR_NOT_SUPPORTED, label))
    } catch (e: Exception) {
      Log.w(TAG, "Could not report the car error", e)
    }
  }

  // ---- JS runtime ------------------------------------------------------------------------

  internal fun needJs() = JsRuntime.ensure(this)

  /** No car and nothing playing: the car task can end. */
  private fun maybeReleaseJs() {
    if (PlayerBridge.carConnected) return
    if (player?.isPlaying == true) return
    JsRuntime.release()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = mediaSession

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
      // A bound browser (Android Auto) keeps a bound service alive regardless; stopSelf only
      // ends the started state, so the car keeps browsing.
      stopSelf()
    }
  }

  override fun onDestroy() {
    if (PlayerBridge.service === this) PlayerBridge.service = null
    handler.removeCallbacksAndMessages(null)
    pendingPlay?.setException(IllegalStateException("Service stopped"))
    pendingPlay = null
    carMonitor?.stop()
    carMonitor = null
    if (PlayerBridge.carConnected) {
      PlayerBridge.carConnected = false
      PlayerBridge.sink?.carConnection(false)
    }
    JsRuntime.release()
    mediaSession?.run {
      player.release()
      release()
    }
    mediaSession = null
    player = null
    exoPlayer = null
    bitmapExecutor?.shutdown()
    bitmapExecutor = null
    // The cache is a process-lifetime singleton (a SimpleCache instance owns its folder);
    // don't release it here, or a service restart couldn't reopen the same folder.
    super.onDestroy()
  }

  /**
   * Media3's provider, minus the bookmark: the notification's own actions stay exactly
   * `[prev] [play] [next] [back] [fwd]` (on API < 33 every custom button becomes a
   * notification action and the sixth would crowd the row); the bookmark still reaches the
   * platform session's custom actions, where Android Auto shows it.
   */
  private class NotificationProvider(context: Context) : DefaultMediaNotificationProvider(context) {
    override fun getMediaButtons(
      session: MediaSession,
      playerCommands: Player.Commands,
      mediaButtonPreferences: ImmutableList<CommandButton>,
      showPauseButton: Boolean,
    ): ImmutableList<CommandButton> = super.getMediaButtons(
      session,
      playerCommands,
      ImmutableList.copyOf(mediaButtonPreferences.filter { it.sessionCommand?.customAction != CMD_BOOKMARK }),
      showPauseButton,
    )
  }

  companion object {
    private const val TAG = "AudiosiloPlayer"

    /** Shared prefs + key used to hand the "task swiped from recents" signal to the
     * module (read+cleared by `consumeTaskRemoved`). The service and module live in
     * the same process; prefs are the simplest durable channel between them. */
    const val PREFS = "audiosilo.player"
    const val KEY_TASK_REMOVED = "task_removed"

    /** How long a car play waits for JS to load the book before Auto shows an error. */
    private const val CAR_PLAY_TIMEOUT_MS = 10_000L

    private val CAR_PACKAGES = setOf(
      "com.google.android.projection.gearhead", // Android Auto (and the DHU)
      "com.android.car.media", // Android Automotive OS media center
      "com.android.car.carlauncher",
    )

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
