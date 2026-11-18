package expo.modules.audiosiloplayer

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
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
import com.google.common.util.concurrent.FutureCallback
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
 *
 * Persisted in the player's prefs (beside the effects) whenever they change, and restored by the
 * service's onCreate: a service started with no JS (Android Auto, playback resumption) used to
 * run with the defaults (no auto-rewind, 30/15 s skips) whatever the listener had set.
 */
object PlayerConfig {
  private const val KEY_AUTO_REWIND = "config.autoRewindMaxMs"
  private const val KEY_JUMP_FORWARD = "config.jumpForwardMs"
  private const val KEY_JUMP_BACKWARD = "config.jumpBackwardMs"

  @Volatile var autoRewindMaxMs: Long = 0
    private set
  // Skip amounts (ms). The seek honors these immediately; the notification glyphs
  // (nearest predefined ICON_SKIP_*) are chosen when the layout is built at start.
  @Volatile var jumpForwardMs: Long = 30_000
    private set
  @Volatile var jumpBackwardMs: Long = 15_000
    private set

  /** Whether the persisted values were read into this process. Guarded by this object. */
  private var restored = false

  /** The module's `setConfig`: takes effect at once, and is persisted when it changed (when a
   * [context] is at hand; the module passes its React context, absent only during teardown). */
  @Synchronized
  fun update(context: Context?, autoRewindMaxMs: Long, jumpForwardMs: Long, jumpBackwardMs: Long) {
    // Read the persisted values first, so "changed" compares against what is on disk and a later
    // restore can't overwrite what JS just set.
    if (context != null) restoreLocked(context) else restored = true
    if (autoRewindMaxMs == this.autoRewindMaxMs && jumpForwardMs == this.jumpForwardMs &&
      jumpBackwardMs == this.jumpBackwardMs
    ) {
      return
    }
    this.autoRewindMaxMs = autoRewindMaxMs
    this.jumpForwardMs = jumpForwardMs
    this.jumpBackwardMs = jumpBackwardMs
    if (context == null) return
    prefs(context).edit()
      .putLong(KEY_AUTO_REWIND, autoRewindMaxMs)
      .putLong(KEY_JUMP_FORWARD, jumpForwardMs)
      .putLong(KEY_JUMP_BACKWARD, jumpBackwardMs)
      .apply()
  }

  /** The service's onCreate: the listener's last values (once per process; JS's own win). */
  @Synchronized
  fun restore(context: Context) = restoreLocked(context)

  private fun restoreLocked(context: Context) {
    if (restored) return
    restored = true
    val prefs = prefs(context)
    autoRewindMaxMs = prefs.getLong(KEY_AUTO_REWIND, autoRewindMaxMs)
    jumpForwardMs = prefs.getLong(KEY_JUMP_FORWARD, jumpForwardMs)
    jumpBackwardMs = prefs.getLong(KEY_JUMP_BACKWARD, jumpBackwardMs)
  }

  private fun prefs(context: Context) =
    context.getSharedPreferences(AudiosiloPlayerService.PREFS, Context.MODE_PRIVATE)
}

/**
 * Shared auth headers for streaming + artwork. They are identical for every track
 * in a book (a single session bearer token, and a proxy's headers), so the module sets them
 * once per load and the data source reads them at request time, ONLY for a request to the
 * server they were given for ([originOf]): the token never goes to any other host. A proxy
 * header goes only to an https origin ([AuthScope.headersFor], fe#295). What a redirect does
 * with them is the HTTP stack's rule, not this one's (CONVENTIONS.md).
 */
object AuthHolder {
  @Volatile
  private var auth: Pair<String, Map<String, String>>? = null

  /** The book's auth headers and the URL of a track they are for (its origin scopes them). */
  fun set(headers: Map<String, String>?, url: String?) {
    val origin = url?.let { originOf(Uri.parse(it)) }
    auth = origin?.let { o -> AuthScope.headersFor(o, headers)?.let { o to it } }
  }

  fun clear() {
    auth = null
  }

  /** The headers for a request to [uri]: the book's, when it is the book's server. */
  fun headersFor(uri: Uri): Map<String, String> {
    val (origin, headers) = auth ?: return emptyMap()
    return if (originOf(uri) == origin) headers else emptyMap()
  }

  private fun originOf(uri: Uri): String? = AuthScope.origin(uri.scheme, uri.host, uri.port)
}

/**
 * Hosts the ExoPlayer + MediaSession so playback survives in the background. Media3
 * renders the media notification / lock-screen controls and runs the foreground
 * service automatically. The Expo module drives it through a MediaController.
 *
 * Lock screen (Audible-parity): a chapter-relative scrubber + prev/next-chapter buttons
 * (chapters are clipped media items, see [MediaItems]) + skip buttons at the listener's skip
 * lengths (the nearest predefined Media3 icons) + the app logo as the notification small icon.
 *
 * A [MediaLibraryService] so Android Auto can browse (the car snapshot JS writes, see
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

  /** A car play JS must start (its car item [id] and its [book], null from an older snapshot),
   * waiting for the module's next `load` (see [playFromCar]). */
  private class PendingPlay(
    val id: String,
    val book: BookRef?,
    val future: SettableFuture<MediaItemsWithStartPosition>,
  )

  private var pendingPlay: PendingPlay? = null

  /** The book of the car play last given up on ([endPendingPlay]), until a play completes: its
   * load, when JS was past stopping it, never completes the play that took its place
   * ([PlayerBridge.completesCarPlay]). */
  private var calledOff: BookRef? = null
  /** A car play given up on, which JS may still load ([replaced]: JS was told another play
   * took its place, so it loads nothing for it). */
  private class GivenUp(val id: String, val book: BookRef?, var replaced: Boolean)

  /** The car play last given up on, until the app's next load ([onAppLoad], [giveWayTo]). */
  private var lateLoad: GivenUp? = null
  /** A car play that timed out. One made during a media button start ends that start too
   * ([playFromCar] watches every pending play, fe#252). */
  private val pendingTimeout = Runnable { failPendingPlay() }

  /** Keeps where the engine is on disk, for a resumption after a crash or a kill ([LivePlace]). */
  private var livePlaces: LivePlaceRecorder? = null

  /** The snapshot the car was last told about ([onSnapshotChanged]); null before the first. */
  private var shownSnapshot: CarSnapshot? = null

  /** The labels the current button layout was built with ([mediaButtons]). */
  private var layoutLabels: CarLabels? = null

  /** (package, uri) artwork grants already made ([grantArtwork]). Main thread. */
  private val artworkGrants = HashSet<Pair<String, Uri>>()

  /** Smart Speed / Voice Boost as last saved to prefs ([applyEffects]). */
  private var savedEffects: Pair<Boolean, Boolean>? = null

  /** The bookmark button shows "filled" for a moment after a press. */
  private var bookmarkFilled = false
  private val bookmarkUnfill = Runnable {
    bookmarkFilled = false
    mediaSession?.setCustomLayout(mediaButtons())
  }

  override fun onCreate() {
    super.onCreate()
    // The car snapshot is read off the main thread; until it is in, the buttons carry their
    // English labels (as before the first snapshot), and the layout is re-set once it is.
    CarSnapshotStore.preload(this) { handler.post { refreshLayout() } }
    LivePlaceStore.preload(this)
    // A service started without JS (the car, playback resumption) uses the listener's last
    // auto-rewind and skip intervals; the module's setConfig updates them whenever JS runs.
    PlayerConfig.restore(this)

    val httpFactory = DefaultHttpDataSource.Factory()
    // The auth headers go per request, and only to the server the app loaded the book from
    // (AuthHolder): never to another host a media item or an artwork URI names.
    val upstream: DataSource.Factory = ResolvingDataSource.Factory(httpFactory) { dataSpec ->
      val headers = AuthHolder.headersFor(dataSpec.uri)
      if (headers.isEmpty()) dataSpec else dataSpec.withAdditionalHeaders(headers)
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
    // An MP3 with no seek header is held to the length the server measured (KnownDurations.kt):
    // Media3's first-frame guess read a VBR file as a fifth of its length.
    val knownDurations = KnownDurations()
    val mediaSourceFactory = KnownDurationMediaSourceFactory(
      DefaultMediaSourceFactory(dataSourceFactory, KnownDurationExtractorsFactory(knownDurations)),
      knownDurations,
    )

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
    savedEffects = smart to boost
    exoPlayer = exo
    exo.addListener(object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        // A book playing with no JS (started from the car, or resumed) must still save its
        // progress: boot JS, which adopts the loaded book (store `adoptLoaded`).
        if (isPlaying) needJs() else maybeReleaseJs()
      }

      // Registered before the session's own listener, so this runs first.
      override fun onPlayerError(error: PlaybackException) = onEngineFailed(exo, error)

      // A new queue (or another item of it) may name another cover: the car may open it.
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = grantPlayingArtwork()
    })
    val audiobookPlayer = AudiobookPlayer(exo, PlayerHooks())
    player = audiobookPlayer
    exo.addListener(LivePlaceListener(exo))

    // Authenticated artwork loader (uses the same headers as the stream). Retain the
    // executor so onDestroy can shut it down - an unmanaged newSingleThreadExecutor leaks
    // its non-daemon thread when the service dies.
    val executor = Executors.newSingleThreadExecutor()
    bitmapExecutor = executor
    // A streamed cover is named by a token-free URI (RemoteArtwork.shareable, fe#349): the
    // loader alone turns it back into the server URL it stands for.
    val artworkSourceFactory = ResolvingDataSource.Factory(dataSourceFactory) { dataSpec ->
      RemoteArtwork.resolve(dataSpec.uri.toString())?.let { dataSpec.withUri(Uri.parse(it)) } ?: dataSpec
    }
    val bitmapLoader = CacheBitmapLoader(
      DataSourceBitmapLoader.Builder(this)
        .setExecutorService(MoreExecutors.listeningDecorator(executor))
        .setDataSourceFactory(artworkSourceFactory)
        .build(),
    )

    // App logo as the notification small icon (Media3's default is a generic glyph).
    // Must be a white/transparent silhouette - the system tints it.
    setMediaNotificationProvider(
      NotificationProvider(this).apply { setSmallIcon(R.drawable.ic_notification) },
    )

    val builder = MediaLibrarySession.Builder(this, audiobookPlayer, LibraryCallback(this))
    // A tap on the notification (outside its buttons) opens the app, as every media app's
    // does: the session activity is the notification's content intent (fe#300).
    openAppIntent()?.let { builder.setSessionActivity(it) }
    mediaSession = builder
      .setBitmapLoader(bitmapLoader)
      // Use setCustomLayout (NOT setMediaButtonPreferences): the slot-based preferences
      // capped the notification at 3 actions on 1.5.1 (it drops the secondary slots -
      // verified via dumpsys, actions=3). setCustomLayout makes the provider build
      // [prev, play/pause, next] (auto, from command availability) + the custom skip
      // buttons -> all 5 actions, alongside the draggable chapter scrubber. (dumpsys: actions=5)
      .setCustomLayout(mediaButtons())
      .build()

    livePlaces = LivePlaceRecorder(
      place = ::livePlaceNow,
      save = { LivePlaceStore.save(this, it) },
      clear = { LivePlaceStore.clear(this) },
      schedule = { r, ms -> handler.postDelayed(r, ms) },
      unschedule = handler::removeCallbacks,
    )

    carMonitor = CarConnectionMonitor(this) { updateCarConnection() }.also { it.start() }
    PlayerBridge.service = this
  }

  /** The car snapshot (null until JS wrote one). */
  internal fun snapshot(): CarSnapshot? = CarSnapshotStore.get(this)

  /** What a playback resumption starts: the book the engine was last heard on, at that place,
   * else the one the snapshot names ([CarSnapshot.resumable]). */
  internal fun resumable(): CarItem? = snapshot()?.resumable(LivePlaceStore.get(this))

  /** The player's events that keep the [LivePlace]. */
  private inner class LivePlaceListener(private val exo: ExoPlayer) : Player.Listener {
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      livePlaces?.onIsPlayingChanged(isPlaying)
    }

    override fun onPositionDiscontinuity(
      oldPosition: Player.PositionInfo,
      newPosition: Player.PositionInfo,
      reason: Int,
    ) {
      if (reason == Player.DISCONTINUITY_REASON_SEEK) livePlaces?.onSeek()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
      if (playbackState == Player.STATE_ENDED) livePlaces?.drop()
    }

    override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
      if (exo.mediaItemCount == 0) livePlaces?.drop()
    }
  }

  /** Where the engine is, as the [LivePlace] to keep: null with nothing loaded, at the end of
   * the book, or when the items name no book (a load from an older JS). */
  private fun livePlaceNow(): LivePlace? {
    val p = player ?: return null
    if (p.playbackState == Player.STATE_ENDED) return null
    val item = p.currentMediaItem ?: return null
    val book = MediaItems.bookOf(item) ?: return null
    val (fileIndex, position) = currentFilePosition() ?: return null
    return LivePlace(book, MediaItems.relPathOf(item), fileIndex, position)
  }

  /**
   * The custom buttons. Media3's notification provider builds the action row as **standard
   * [prev, play/pause, next]** (auto-added from the player's available seek-to-prev/next
   * commands - present for a chaptered book, absent for a single-item/chapterless book)
   * **plus the CUSTOM-command buttons** from the custom layout. So we declare the two skip
   * buttons (and the bookmark, below) and let prev/next-chapter fill in -> the full
   * `[prev] [play] [next] [back] [fwd]` row.
   *
   * They MUST be custom session commands (see [LibraryCallback]); the standard
   * COMMAND_SEEK_BACK/FORWARD map to the legacy ACTION_REWIND/FAST_FORWARD the modern media
   * UI ignores. Predefined `ICON_SKIP_*` icons (the nearest of 5/10/15/30, [skipIcon]) render
   * without an app-shipped drawable.
   *
   * The bookmark comes THIRD: System UI (API 33+) shows play, prev, next and only the first
   * two custom actions, so the phone keeps exactly today's row, while Android Auto lists every
   * custom action (the bookmark in its overflow). [NotificationProvider] leaves it out of the
   * notification's own actions so `dumpsys notification` stays at actions=5.
   *
   * Never reads the disk (the snapshot may still be loading): records the labels it used, so
   * [refreshLayout] re-sets the layout once they change.
   */
  private fun mediaButtons(): List<CommandButton> {
    val labels = CarSnapshotStore.peek()?.labels
    layoutLabels = labels
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

    override fun requester(): String? = mediaSession?.controllerForCurrentRequest?.let(::describe)
  }

  /** A controller as [MediaKeyLog] shows it: its package, Media3 or legacy, and our role for it. */
  internal fun describe(c: MediaSession.ControllerInfo): String {
    val role = when {
      PlayerBridge.isAppController(c) -> " (app)"
      mediaSession?.isMediaNotificationController(c) == true -> " (notification)"
      isCarController(c) -> " (car)"
      else -> ""
    }
    val kind = if (c.controllerVersion == MediaSession.ControllerInfo.LEGACY_CONTROLLER_VERSION) "legacy" else "media3"
    return "${c.packageName} $kind$role"
  }

  /** Where the player is, in FILE coordinates (from the current item's extras). */
  private fun currentFilePosition(): Pair<Int, Double>? {
    val p = player ?: return null
    if (p.mediaItemCount == 0) return null
    return TimelineMap.toFile(MediaItems.entryOf(p.currentMediaItem), p.currentMediaItemIndex, p.currentPosition)
  }

  // ---- Effects ---------------------------------------------------------------------------

  internal fun applyEffects(smartSpeed: Boolean, voiceBoost: Boolean) {
    val exo = exoPlayer ?: return
    AudioEffects.apply(exo, smartSpeed, voiceBoost)
    val effects = smartSpeed to voiceBoost
    if (effects != savedEffects) {
      savedEffects = effects
      AudioEffects.save(this, smartSpeed, voiceBoost)
    }
  }

  // ---- Bookmarks -------------------------------------------------------------------------

  /** The bookmark button: JS saves it when it listens, else it waits in the pending list (and
   * JS boots to drain it). The icon shows "filled" for ~2 s either way. */
  internal fun onBookmarkPressed() {
    val p = player ?: return
    val (fileIndex, position) = currentFilePosition() ?: return
    val item = p.currentMediaItem
    val book = MediaItems.bookOf(item)
    // The file by its path too (fe#185): JS may reload the book in another file order (an
    // adoption in the download's order) before it reads the press, and the index alone would
    // then name another file.
    val relPath = MediaItems.relPathOf(item)
    val sink = PlayerBridge.sink
    if (sink != null && sink.observingBookmarks) {
      // With its book: JS may not have adopted the book the engine plays yet (a car start
      // the JS boot is still adopting), and the press belongs to the book the listener heard.
      sink.remoteBookmark(fileIndex, position, book, relPath)
    } else {
      book ?: return // can't name the book: drop it
      PendingBookmarks.append(this, book, fileIndex, relPath, position)
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
      // A (re)connecting car may be a restarted Auto app, whose URI grants went with it.
      artworkGrants.clear()
      carControllers.add(controller)
      grantPlayingArtwork()
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

  /** The snapshot changed (`setCarSnapshot`): tell the car which lists changed (JS re-sends the
   * whole snapshot on every change, often with most tabs as they were), and re-set the buttons
   * when their labels changed. */
  internal fun onSnapshotChanged() {
    val session = mediaSession ?: return
    val snapshot = snapshot()
    val previous = shownSnapshot
    shownSnapshot = snapshot
    if (snapshot == null || previous == null || previous.signedIn != snapshot.signedIn) {
      // Nothing shown yet, or signing in/out: every list is new.
      session.notifyChildrenChanged(CarBrowseTree.ROOT, snapshot?.tabs?.size ?: 0, null)
      snapshot?.tabs?.forEach { session.notifyChildrenChanged(CarBrowseTree.tabId(it), it.items.size, null) }
    } else {
      if (rootChanged(previous, snapshot)) session.notifyChildrenChanged(CarBrowseTree.ROOT, snapshot.tabs.size, null)
      for (tab in snapshot.tabs) {
        if (tabChanged(previous, snapshot, tab)) session.notifyChildrenChanged(CarBrowseTree.tabId(tab), tab.items.size, null)
      }
    }
    refreshLayout()
  }

  /** The root's children: the tabs (ids and titles), or the signed-out label. */
  private fun rootChanged(previous: CarSnapshot, snapshot: CarSnapshot): Boolean =
    previous.tabs.map { it.id to it.title } != snapshot.tabs.map { it.id to it.title } ||
      previous.labels.signedOut != snapshot.labels.signedOut

  /** A tab's children: its books, or the empty label. */
  private fun tabChanged(previous: CarSnapshot, snapshot: CarSnapshot, tab: CarTab): Boolean {
    val before = previous.tabs.firstOrNull { it.id == tab.id } ?: return true
    return before.items != tab.items || (tab.items.isEmpty() && previous.labels.empty != snapshot.labels.empty)
  }

  /** Re-sets the button layout when the snapshot's labels differ from the ones it was built with. */
  private fun refreshLayout() {
    val session = mediaSession ?: return
    if (CarSnapshotStore.peek()?.labels == layoutLabels) return
    session.setCustomLayout(mediaButtons())
  }

  /** Lets the browsing app (Android Auto's package) open a cover's content URI; each (package,
   * uri) once, since every browse of a tab asks again. */
  internal fun grantArtwork(browser: MediaSession.ControllerInfo, uri: Uri) {
    val grant = browser.packageName to uri
    if (!artworkGrants.add(grant)) return
    try {
      grantUriPermission(browser.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    } catch (e: Exception) {
      artworkGrants.remove(grant)
      Log.w(TAG, "Could not grant artwork to ${browser.packageName}", e)
    }
  }

  /** Lets every connected car open the loaded item's cover, when it is one the artwork provider
   * serves (a downloaded book's, [LocalArtwork]): the car loads the playing item's artwork URI
   * itself. A streamed cover's URI is the app's own, which no grant opens. */
  private fun grantPlayingArtwork() {
    val uri = player?.currentMediaItem?.mediaMetadata?.artworkUri ?: return
    if (uri.scheme != "content" || uri.authority != ArtworkProvider.authority(this)) return
    for (car in carControllers) grantArtwork(car, uri)
  }

  /**
   * True from a media button start with nothing loaded ([ResumptionReceiver] started us as a
   * FOREGROUND service) until that resumption played or failed. Main thread only.
   */
  private var buttonStart = false
  /** A start whose resumption never answers (Media3 ignored the press) is released all the same. */
  private val buttonStartTimeout = Runnable { endButtonStart(failed = true) }

  /**
   * A media button start (the receiver's `startForegroundService`) must reach `startForeground`
   * within seconds whatever the resumption does next, and a resumption can take up to
   * [CAR_PLAY_TIMEOUT_MS] when it goes through JS. So such a start goes into the foreground at
   * once with a placeholder under Media3's own notification id and channel: Media3's
   * notification replaces it when the book plays, and [endButtonStart] removes it when the
   * resumption fails ([watchResumption]) or never answers ([buttonStartTimeout]).
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val mediaButton = intent?.action == Intent.ACTION_MEDIA_BUTTON
    val items = player?.mediaItemCount ?: 0
    if (mediaButton) MediaKeyLog.d { "service start: ${MediaKeyLog.describe(intent)}, items=$items" }
    // Every such start needs its own startForeground, a second press while the first waits too.
    if (mediaButton && items == 0 && startPlaceholderForeground()) {
      buttonStart = true
      handler.removeCallbacks(buttonStartTimeout)
      handler.postDelayed(buttonStartTimeout, BUTTON_START_TIMEOUT_MS)
    }
    return super.onStartCommand(intent, flags, startId)
  }

  /** A media button start is over: on a failure with nothing loaded, the placeholder goes and the
   * started service stops (a bound browser, Android Auto, keeps it alive regardless). */
  private fun endButtonStart(failed: Boolean) {
    if (!buttonStart) return
    buttonStart = false
    handler.removeCallbacks(buttonStartTimeout)
    if (!failed || (player?.mediaItemCount ?: 0) > 0) return // Media3's notification owns it now
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  /**
   * Opens the app where it is: its launcher activity (`singleTask`, so the running one comes
   * to the front rather than a second copy). Null when the package has no launcher activity.
   */
  private fun openAppIntent(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(
      this,
      0,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  /** The placeholder foreground notification ([onStartCommand]); false when not allowed. */
  private fun startPlaceholderForeground(): Boolean {
    // Media3's channel, as Media3 creates it (a no-op when it exists; ignored below API 26).
    NotificationManagerCompat.from(this).createNotificationChannel(
      NotificationChannelCompat.Builder(
        DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID,
        NotificationManagerCompat.IMPORTANCE_LOW,
      ).setName(getString(DefaultMediaNotificationProvider.DEFAULT_CHANNEL_NAME_RESOURCE_ID)).build(),
    )
    // peek: the receiver that started us loaded the snapshot; never a disk read here.
    val title = CarSnapshotStore.peek()?.resumable(LivePlaceStore.get(this))?.title
      ?: applicationInfo.loadLabel(packageManager).toString()
    val notification = NotificationCompat.Builder(this, DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(title)
      .setContentIntent(openAppIntent())
      .setSilent(true)
      .setOngoing(true)
      .build()
    return try {
      ServiceCompat.startForeground(
        this,
        DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      )
      true
    } catch (e: Exception) {
      // Not a foreground start after all (Android 12+ refuses one from the background).
      Log.w(TAG, "Could not start the resumption in the foreground", e)
      false
    }
  }

  /**
   * A play resumption's [future], watched: when it fails after a media button start and nothing
   * else loaded meanwhile, the placeholder goes and the started service stops ([endButtonStart]),
   * so a press with nothing to resume never leaves a foreground start the system kills the app for.
   * [playFromCar] watches every play it leaves pending too, so a car tap that replaced the
   * resumption ends the start as well, whichever way it fails (its timeout, a load that left
   * nothing loaded): the placeholder never waits for [buttonStartTimeout] then (fe#252).
   */
  internal fun watchResumption(
    future: ListenableFuture<MediaItemsWithStartPosition>,
  ): ListenableFuture<MediaItemsWithStartPosition> {
    Futures.addCallback(
      future,
      object : FutureCallback<MediaItemsWithStartPosition> {
        override fun onSuccess(result: MediaItemsWithStartPosition) = endButtonStart(failed = false)

        // A JS-routed resumption superseded by a newer one (giveWayTo) fails too: the
        // newer one, still pending, keeps the start (its own answer or the timeout ends it).
        override fun onFailure(t: Throwable) {
          if (pendingPlay == null) endButtonStart(failed = true)
        }
      },
      ContextCompat.getMainExecutor(this),
    )
    return future
  }

  /**
   * The car (or a resumption) asked to play a snapshot book.
   *  - The book the player already has: it plays on from where it is ([playingQueue]).
   *  - No JS runtime and the book is downloaded (has a play spec): start it now, from the
   *    spec; JS boots once it plays and adopts it (`getLoadedBook`).
   *  - Otherwise JS starts it (`onCarPlayRequest`, queued until JS listens; JS boots when
   *    needed). The returned future completes when the module's next `load` arrives (with the
   *    queue JS just loaded), or fails after ~10 s with the snapshot's "unavailable" label.
   *    While a JS runtime exists, even a downloaded book goes through JS: JS may hold another
   *    book as `nowPlaying`, and swapping the engine under it would save one book's place as
   *    another's.
   * [item] is the snapshot's (a resumption's starts at the live place: [resumable]); null when
   * the snapshot lists none.
   */
  internal fun playFromCar(item: CarItem?, requirePlaySpec: Boolean): ListenableFuture<MediaItemsWithStartPosition> {
    val spec = item?.play
    if (item == null || (requirePlaySpec && spec == null)) {
      sendUnavailable()
      return Futures.immediateFailedFuture(UnsupportedOperationException("Unknown car item"))
    }
    // The book already loaded (the first Continue listening row, so the most common tap): it
    // plays on from where it is, as on iOS. Sent to JS, the request waited for a `load` JS
    // never makes for its own book, and the car said "unavailable" 10 s later while it played.
    item.book?.let { playingQueue(it) }?.let {
      giveWayTo(null)
      return Futures.immediateFuture(it)
    }
    // Natively only with no JS runtime at all: one that runs may hold another book as
    // `nowPlaying` (even with its car sync not listening yet), and swapping the engine under
    // it would map this book's place onto that one.
    if (spec != null && PlayerBridge.sink == null) {
      // It takes the place of a play still waiting for JS (a streamed book tapped while JS
      // boots): that one ends quietly, or a JS that listens later would start it over this one.
      giveWayTo(null)
      // The book the engine was last heard on starts where it was (a crash since its last
      // snapshot write): a car tap's spec holds the place JS last wrote.
      val queue = MediaItems.startPositionOf(spec.at(LivePlaceStore.get(this)), ArtworkProvider.authority(this))
      // Every track of a play spec is a local file: no auth headers.
      AuthHolder.clear()
      player?.internal { player?.setPlaybackParameters(PlaybackParameters(spec.rate.toFloat(), 1.0f)) }
      return Futures.immediateFuture(queue)
    }
    giveWayTo(item.id)
    val future = SettableFuture.create<MediaItemsWithStartPosition>()
    pendingPlay = PendingPlay(item.id, item.book ?: spec?.book, future)
    // Whoever asked: this play is now the one a media button start waits on.
    watchResumption(future)
    handler.postDelayed(pendingTimeout, CAR_PLAY_TIMEOUT_MS)
    PlayerBridge.requestCarPlay(item.id)
    needJs()
    return future
  }

  /** The player's own queue at its place when it has [book] loaded (any book with null) and
   * can play on (ready or buffering), else null. Media3 then sets that same queue again
   * (absorbed, see [AudiobookPlayer.absorbIdenticalSet]) and plays: a paused book resumes,
   * with auto-rewind; an ended or failed one goes the usual way, through JS (a failed one
   * reads as ready to controllers, [AudiobookPlayer.failed]: asked for here). */
  private fun playingQueue(book: BookRef?): MediaItemsWithStartPosition? {
    val p = player ?: return null
    if (p.mediaItemCount == 0 || p.failed) return null
    if (book != null && MediaItems.bookOf(p.currentMediaItem) != book) return null
    val state = p.playbackState
    if (state != Player.STATE_READY && state != Player.STATE_BUFFERING) return null
    p.absorbIdenticalSet = true
    // Media3 applies the result on this looper (at once, or posted ahead of this): clear the
    // flag after it, so a later identical load of the app's (a retry) is never skipped.
    handler.post { player?.absorbIdenticalSet = false }
    return MediaItemsWithStartPosition(p.mediaItems(), p.currentMediaItemIndex, p.currentPosition)
  }

  /**
   * A voice or search play from the car (the Assistant's "play AudioSilo", "play <title> on
   * AudioSilo"; Media3 hands it over as an item with no id and the query): the listed book whose
   * title holds the query, else what the listener most likely means, the loaded book playing
   * on, else the first Continue listening book. "Unavailable" only when there is none.
   */
  internal fun playFromSearch(query: String?): ListenableFuture<MediaItemsWithStartPosition> {
    val snapshot = snapshot()
    val q = query?.trim().orEmpty()
    val match = if (q.isEmpty()) null else snapshot?.findByTitle(q)
    if (match != null) return playFromCar(match, requirePlaySpec = false)
    playingQueue(null)?.let {
      giveWayTo(null)
      return Futures.immediateFuture(it)
    }
    val first = snapshot?.firstContinue()
    if (first == null) {
      sendUnavailable()
      return Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to play"))
    }
    return playFromCar(first, requirePlaySpec = false)
  }

  /** The module's `load` of [book] arrived (the app's controller set a queue). Completes a
   * pending car play with that queue; the identical re-set Media3 then makes is absorbed by the
   * player. Never with the late load of the play called off for it (JS loads that one paused):
   * the pending play still waits for its own load, or its timeout. */
  internal fun onAppLoad(book: BookRef?) {
    // The book the app loads is the one the snapshot names, at the place JS gave it, until it
    // plays or moves: the place kept for the queue it replaces is not this one's.
    livePlaces?.drop()
    // The next load after a call-off may be the called-off play's own, which JS loads paused: it
    // goes in paused, so it is never heard for the moment before JS's pause lands (Media3
    // pressed play on the player when that play failed). Any other load comes first only when
    // JS started something else, and then JS never loads the called-off book.
    val late = lateLoad?.book
    lateLoad = null
    if (book != null && book == late && book != pendingPlay?.book) player?.playWhenReady = false
    if (pendingPlay == null) return
    // Posted: the app's items are applied right after this callback returns.
    handler.post {
      val pending = pendingPlay ?: return@post
      val p = player ?: return@post
      val loaded = MediaItems.bookOf(p.currentMediaItem)
      if (!PlayerBridge.completesCarPlay(loaded, pending.book, calledOff)) return@post
      val future = pending.future
      pendingPlay = null
      calledOff = null
      handler.removeCallbacks(pendingTimeout)
      val items = p.mediaItems()
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

  /** The pending car play's wait ran out without the app's load. JS, which may still be
   * starting it (a slow server), is told to drop it ([PlayerBridge.cancelCarPlay]): played
   * later, after a media button start was released, it would play in the background with no
   * foreground notification and no controls. The car is told too ("unavailable"). */
  private fun failPendingPlay() {
    if (endPendingPlay("The car play request timed out", replaced = false)) sendUnavailable()
  }

  /**
   * Another play takes the player: the loaded book playing on or a start made here ([id]
   * null), or the car play of [id] (a book's car item id) about to wait for JS. The last tap
   * wins (fe#350).
   *  - The car play still waiting ends for it, and JS loads nothing for it (`replaced`). The
   *    car is told nothing: it has the new play to show.
   *  - So does the play whose wait already ran out while JS may still be starting it
   *    ([lateLoad]): told only that its wait ran out, JS would load it, paused, over the play
   *    made since, which the car just asked for.
   *  - Never the same book asked for again (its row tapped twice, or again after its wait ran
   *    out): its start in JS is the one this request joins. Told to drop it and then asked for
   *    it, a start that read the mark in between loaded nothing, and the request joined to it
   *    waited out its 10 s. Its wait alone ends, for the new one.
   */
  private fun giveWayTo(id: String?) {
    val pending = pendingPlay
    if (pending != null) {
      if (pending.id == id) {
        handler.removeCallbacks(pendingTimeout)
        pendingPlay = null
        pending.future.setException(IllegalStateException("The car asked for it again"))
      } else {
        endPendingPlay("Another play took its place", replaced = true)
      }
      return
    }
    val late = lateLoad ?: return
    if (late.replaced || late.id == id) return
    late.replaced = true
    PlayerBridge.cancelCarPlay(late.id, replaced = true)
  }

  /** Fails the pending car play with [error] and tells JS to drop it ([replaced]: another
   * play took its place); false with none. */
  private fun endPendingPlay(error: String, replaced: Boolean): Boolean {
    handler.removeCallbacks(pendingTimeout)
    val pending = pendingPlay ?: return false
    pendingPlay = null
    calledOff = pending.book
    lateLoad = GivenUp(pending.id, pending.book, replaced)
    PlayerBridge.cancelCarPlay(pending.id, replaced)
    pending.future.setException(IllegalStateException(error))
    return true
  }

  /**
   * The engine failed (a stream that could not be read): it is shown as stopped, never as a
   * fatal error ([AudiobookPlayer.failed], fe#157). It stops wanting to play, here before the
   * session reads it, so the platform session says paused with play available and nothing
   * plays until a press; the app hears of the failure from here (the session no longer shows
   * it), and the car shows why, in the listener's language, as a non-fatal error.
   */
  private fun onEngineFailed(exo: ExoPlayer, error: PlaybackException) {
    exo.playWhenReady = false
    PlayerBridge.sink?.playerFailed()
    // peek: never a disk read on the main thread (the snapshot is preloaded in onCreate).
    val label = CarSnapshotStore.peek()?.labels?.playbackError?.ifEmpty { null } ?: error.message ?: return
    sendSessionError(SessionError.ERROR_IO, label)
  }

  /** An error Android Auto shows (the platform session's error state), in the listener's
   * language (the snapshot's label). */
  private fun sendUnavailable() {
    val label = snapshot()?.labels?.unavailable?.ifEmpty { null } ?: return
    sendSessionError(SessionError.ERROR_NOT_SUPPORTED, label)
  }

  /** Sends [label] to the session's controllers as a non-fatal error of [code]. */
  private fun sendSessionError(code: Int, label: String) {
    try {
      mediaSession?.sendError(SessionError(code, label))
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
    // The pendingPlay failed below reaches watchResumption after this: nothing left to end.
    buttonStart = false
    handler.removeCallbacksAndMessages(null)
    // A car request JS never received dies with the service: delivered to a JS that starts
    // listening later (the car long gone), it would start the book on the phone. One it did
    // receive is dropped there too.
    endPendingPlay("Service stopped", replaced = false)
    PlayerBridge.pendingCarPlayId = null
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

    /** How long a media button start waits for its resumption to answer ([buttonStartTimeout]):
     * past a JS-routed one ([CAR_PLAY_TIMEOUT_MS]). */
    private const val BUTTON_START_TIMEOUT_MS = CAR_PLAY_TIMEOUT_MS + 5_000L

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
