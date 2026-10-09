package expo.modules.audiosiloplayer

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import expo.modules.audiosiloplayer.effects.AudioEffects
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class TrackRecord : Record {
  @Field var id: String = ""
  @Field var url: String = ""
  @Field var headers: Map<String, String>? = null
  @Field var title: String = ""
  @Field var album: String? = null
  @Field var artist: String? = null
  @Field var artwork: String? = null
  @Field var duration: Double? = null
}

/**
 * One chapter clip (mirrors the JS PlaybackChapter). The module turns each into a
 * clipped MediaItem so the lock screen gets a chapter-relative scrubber and prev/next
 * chapter. `fileIndex` indexes into the loaded tracks; `startInFile`/`endInFile` bound
 * the clip within that file (endInFile <= 0 => to end of file).
 */
class ChapterRecord : Record {
  @Field var fileIndex: Int = 0
  @Field var startInFile: Double = 0.0
  @Field var endInFile: Double = 0.0
  @Field var title: String = ""
}

/** `load`'s optional 5th argument: which book the queue is. */
class BookRecord : Record {
  @Field var connectionId: String = ""
  @Field var libraryId: Double = 0.0
  @Field var path: String = ""
}

class ConfigRecord : Record {
  @Field var autoRewindMax: Double = 0.0
  @Field var jumpForward: Double = 30.0
  @Field var jumpBackward: Double = 15.0
  /** Absent from an older JS bundle (then the effects are left alone). */
  @Field var smartSpeed: Boolean? = null
  @Field var voiceBoost: Boolean? = null
}

/**
 * Bridges the JS playback API to a Media3 MediaLibraryService via a MediaController.
 * Positions are reported per-FILE (seconds); the JS store maps them onto the whole-book
 * timeline. When chapters are supplied each chapter is a clipped media item, and this
 * module translates the engine's clip indices/positions back to file-relative ones so
 * the store's file-based math is unchanged ([TimelineMap], rebuilt from the controller's
 * timeline so it is right for a queue the SERVICE loaded too). All controller access happens on
 * the main thread.
 */
class AudiosiloPlayerModule : Module() {
  private var controller: MediaController? = null
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private val connectWaiters = mutableListOf<(Exception?) -> Unit>()
  private val handler = Handler(Looper.getMainLooper())
  private var progressRunnable: Runnable? = null
  private var lastTrackIndex: Int = -1
  /** The engine items' FILE mapping (chapter clips or whole files), from their extras. */
  private var timelineMap: TimelineMap = TimelineMap(emptyList())
  /** Output gain (0..1) last asked for by JS - the sleep timer's fade-out. Kept here so a
   * reconnect re-applies it: the controller can be rebuilt against a freshly started
   * service whose ExoPlayer is back at full volume, which would abort a fade mid-way. */
  private var lastVolume: Float = 1.0f
  /** Smart Speed / Voice Boost last asked for by JS (null: never), re-sent on a reconnect. */
  private var lastEffects: Pair<Boolean, Boolean>? = null

  /** A remote move the service reported, emitted once the controller's own position caught up
   * (its next discontinuity), so `onRemoteMove` follows the `onProgress` that shows it. */
  private var pendingRemoteMove: Pair<Int, Double>? = null
  private val remoteMoveFallback = Runnable { flushRemoteMove() }

  @Volatile private var observingBookmarks = false
  @Volatile private var observingCar = false
  @Volatile private var observingCarConnection = false

  private val sink = object : PlayerEventSink {
    override fun remoteMove(fileIndex: Int, position: Double) {
      pendingRemoteMove = Pair(fileIndex, position)
      handler.removeCallbacks(remoteMoveFallback)
      handler.postDelayed(remoteMoveFallback, REMOTE_MOVE_FALLBACK_MS)
    }

    override fun rateChange(rate: Double) {
      sendEvent("onRateChange", mapOf("rate" to rate))
    }

    override fun remoteBookmark(fileIndex: Int, position: Double, book: BookRef?) {
      val place: Map<String, Any> = mapOf("trackIndex" to fileIndex, "position" to position)
      val named: Map<String, Any> = book?.let {
        mapOf("connectionId" to it.connectionId, "libraryId" to it.libraryId.toDouble(), "path" to it.path)
      } ?: emptyMap()
      sendEvent("onRemoteBookmark", place + named)
    }

    override fun carConnection(connected: Boolean) {
      if (observingCarConnection) sendEvent("onCarConnection", mapOf("connected" to connected))
    }

    override fun carPlayRequest(id: String) {
      sendEvent("onCarPlayRequest", mapOf("id" to id))
    }

    override val observingBookmarks: Boolean get() = this@AudiosiloPlayerModule.observingBookmarks
    override val observingCar: Boolean get() = this@AudiosiloPlayerModule.observingCar
  }

  private val context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  override fun definition() = ModuleDefinition {
    Name("AudiosiloPlayer")

    Events(
      "onState",
      "onProgress",
      "onTrackChange",
      "onRemoteMove",
      "onRateChange",
      "onRemoteBookmark",
      "onCarConnection",
      "onCarPlayRequest",
    )

    OnCreate {
      PlayerBridge.sink = sink
    }

    // Car events JS couldn't hear yet (a car tap that booted JS, a connect before the car
    // controller listened) are delivered the moment it starts listening.
    // On the main thread, like the service's `requestCarPlay` it hands off with: Expo runs
    // these on its own queue, where the check-then-act of the two could lose a request (or
    // deliver an older one after a newer).
    OnStartObserving("onCarPlayRequest") {
      handler.post {
        observingCar = true
        PlayerBridge.pendingCarPlayId?.let { id ->
          PlayerBridge.pendingCarPlayId = null
          sendEvent("onCarPlayRequest", mapOf("id" to id))
        }
      }
    }
    OnStopObserving("onCarPlayRequest") { handler.post { observingCar = false } }
    OnStartObserving("onCarConnection") {
      observingCarConnection = true
      if (PlayerBridge.carConnected) sendEvent("onCarConnection", mapOf("connected" to true))
    }
    OnStopObserving("onCarConnection") { observingCarConnection = false }
    OnStartObserving("onRemoteBookmark") { observingBookmarks = true }
    OnStopObserving("onRemoteBookmark") { observingBookmarks = false }

    // True once if the app was swiped away from recents since the last check (set by
    // the service's onTaskRemoved). Read+cleared synchronously so JS can decide, on
    // foreground, whether to reset to Home. Synchronous Function: a single prefs read.
    Function("consumeTaskRemoved") {
      val prefs = context.getSharedPreferences(
        AudiosiloPlayerService.PREFS,
        Context.MODE_PRIVATE,
      )
      val removed = prefs.getBoolean(AudiosiloPlayerService.KEY_TASK_REMOVED, false)
      if (removed) prefs.edit().putBoolean(AudiosiloPlayerService.KEY_TASK_REMOVED, false).apply()
      removed
    }

    AsyncFunction("setup") { promise: Promise ->
      handler.post {
        connect { error ->
          if (error == null) {
            promise.resolve(null)
          } else {
            promise.reject("ERR_MEDIA_CONTROLLER", "Failed to connect to media session", error)
          }
        }
      }
    }

    AsyncFunction("setConfig") { config: ConfigRecord ->
      // Auto-rewind is applied natively (AudiobookPlayer) so it covers lock-screen resumes
      // too. The jump intervals feed the lock-screen skip buttons - the seek amount is read
      // live in the service's custom-command handler; the notification glyphs pick up a
      // changed value on the next service start (nearest predefined ICON_SKIP_*).
      // Persisted too, for a service started without JS (the car, playback resumption).
      PlayerConfig.update(
        appContext.reactContext,
        autoRewindMaxMs = (config.autoRewindMax * 1000).toLong(),
        jumpForwardMs = (config.jumpForward * 1000).toLong(),
        jumpBackwardMs = (config.jumpBackward * 1000).toLong(),
      )
      // Smart Speed + Voice Boost run in the service's audio chain: a custom session command
      // applies them there (and the service keeps them for a start without JS). JS calls
      // setConfig on every settings change, so only a changed pair is sent.
      if (config.smartSpeed != null || config.voiceBoost != null) {
        val effects = Pair(config.smartSpeed ?: false, config.voiceBoost ?: false)
        handler.post {
          if (effects == lastEffects) return@post
          lastEffects = effects
          controller?.let { sendEffects(it, effects) }
        }
      }
    }

    AsyncFunction("load") { tracks: List<TrackRecord>, startIndex: Int, position: Double, chapters: List<ChapterRecord>?, book: BookRecord? ->
      handler.post {
        val c = controller ?: return@post
        // A remote move not reported yet belongs to the queue this load replaces.
        dropRemoteMove()
        // Every streamed track in a book shares the same auth header, for its server.
        val authed = tracks.firstOrNull { !it.headers.isNullOrEmpty() }
        AuthHolder.set(authed?.headers, authed?.url)
        lastTrackIndex = -1
        val specs = tracks.map {
          TrackSpec(it.id, it.url, it.title, it.album, it.artist, it.artwork, it.duration ?: 0.0)
        }
        val clips = chapters.orEmpty().map { ClipSpec(it.fileIndex, it.startInFile, it.endInFile, it.title) }
        val ref = book?.takeIf { it.connectionId.isNotEmpty() && it.path.isNotEmpty() }
          ?.let { BookRef(it.connectionId, it.libraryId.toLong(), it.path) }
        val queue = MediaItems.buildQueue(specs, clips, ref, startIndex, position)
        timelineMap = timelineOf(queue.items)
        c.setMediaItems(queue.items, queue.index, queue.positionMs)
        c.prepare()
        emitTrackChange(startIndex) // emit the FILE index the JS store expects
      }
    }

    AsyncFunction("play") {
      // Auto-rewind on resume now lives in AudiobookPlayer (the session's player), so it
      // applies to lock-screen/notification resumes too; controller.play() routes there.
      handler.post { controller?.play() }
    }

    AsyncFunction("pause") {
      handler.post { controller?.pause() }
    }

    AsyncFunction("seekTo") { seconds: Double ->
      // `seconds` is file-relative (the store's per-track position). In chapter mode it
      // maps to (clip item, clip-relative position).
      handler.post {
        val c = controller ?: return@post
        val map = timelineMap
        if (map.clipped) {
          val fileIndex = map.itemToFile(c.currentMediaItemIndex, 0L).first
          val (idx, ms) = map.fileToItem(fileIndex, seconds)
          c.seekTo(idx, ms)
        } else {
          c.seekTo((seconds * 1000).toLong())
        }
      }
    }

    AsyncFunction("skipToTrack") { index: Int, seconds: Double ->
      // `index` is a FILE index; map it to the clip item that starts that file/position.
      handler.post {
        val c = controller ?: return@post
        val map = timelineMap
        if (map.clipped) {
          val (idx, ms) = map.fileToItem(index, seconds)
          c.seekTo(idx, ms)
        } else {
          c.seekTo(index, (seconds * 1000).toLong())
        }
      }
    }

    AsyncFunction("setRate") { rate: Double ->
      handler.post { controller?.setPlaybackParameters(PlaybackParameters(rate.toFloat(), 1.0f)) }
    }

    // Player gain (0..1), NOT the device/stream volume: Player.setVolume scales only our
    // output, so the sleep timer can fade the book to silence without touching what the
    // user hears from everything else. Sticky - whoever faded down restores it.
    AsyncFunction("setVolume") { volume: Double ->
      handler.post {
        val v = volume.coerceIn(0.0, 1.0).toFloat()
        lastVolume = v
        controller?.volume = v
      }
    }

    AsyncFunction("reset") {
      handler.post {
        dropRemoteMove()
        controller?.stop()
        controller?.clearMediaItems()
        lastTrackIndex = -1
        timelineMap = TimelineMap(emptyList())
        sendEvent("onState", mapOf("state" to "idle"))
      }
    }

    // Open the system media-output switcher so the user can send audio elsewhere
    // (Bluetooth - e.g. an Echo paired as a speaker - or a Cast target). Resolves true
    // if a chooser was launched. The standalone in-app affordance complements the
    // output-switcher chip Media3 already puts in the media notification.
    AsyncFunction("showRoutePicker") { promise: Promise ->
      handler.post { promise.resolve(openOutputSwitcher()) }
    }

    // The car snapshot (JSON, built by src/car/car-model.ts). Written atomically to filesDir so the
    // car shows it at once next time (even with no JS), then the car's lists refresh.
    AsyncFunction("setCarSnapshot") { json: String ->
      CarSnapshotStore.write(context, json)
      handler.post { PlayerBridge.service?.onSnapshotChanged() }
    }

    // The book the SERVICE has loaded (the car started it, or JS restarted while the
    // service kept playing), in FILE coordinates, else null. JS adopts it without reloading.
    AsyncFunction("getLoadedBook") { promise: Promise ->
      handler.post {
        // No service in this process, or one with nothing loaded: nothing to adopt, and no
        // reason to bind (so create) the playback service on every launch just to ask.
        val loaded = PlayerBridge.service?.player
        if (loaded == null || loaded.mediaItemCount == 0) {
          promise.resolve(null)
          return@post
        }
        connect { error ->
          val c = controller
          if (error != null || c == null) {
            promise.resolve(null)
            return@connect
          }
          promise.resolve(loadedBook(c))
        }
      }
    }

    // Bookmarks pressed while no JS listened, oldest first; the read clears them.
    AsyncFunction("consumePendingBookmarks") {
      PendingBookmarks.consume(context)
    }

    OnDestroy {
      if (PlayerBridge.sink === sink) PlayerBridge.sink = null
      handler.post { releaseController() }
    }
  }

  private fun loadedBook(c: MediaController): Map<String, Any>? {
    if (c.mediaItemCount == 0) return null
    val book = MediaItems.bookOf(c.currentMediaItem) ?: return null
    val (fileIndex, position) = timelineMap.itemToFile(c.currentMediaItemIndex, c.currentPosition)
    val ended = c.playbackState == Player.STATE_ENDED || c.playbackState == Player.STATE_IDLE
    return mapOf(
      "connectionId" to book.connectionId,
      "libraryId" to book.libraryId.toDouble(),
      "path" to book.path,
      "trackIndex" to fileIndex,
      "position" to position,
      "rate" to c.playbackParameters.speed.toDouble(),
      "playing" to (c.playWhenReady && !ended),
    )
  }

  /**
   * Launch the system media-output chooser. The MEDIA_OUTPUT settings panel (the same
   * switcher the media notification surfaces) is the lightest path and needs no extra
   * SDK; not every OEM/ROM exposes it, so fall back to Bluetooth settings. Returns
   * whether anything was launched.
   */
  private fun openOutputSwitcher(): Boolean {
    // Resolve the React context defensively: the `context` getter throws (requireNotNull)
    // if it's gone during teardown, and this runs on the main looper outside Expo's promise
    // wrapper - an uncaught throw here would crash and leave the JS promise unresolved.
    // Bail to "nothing shown" instead.
    val ctx = appContext.reactContext ?: return false
    val activity = appContext.currentActivity
    val launchCtx = activity ?: ctx
    val attempts = listOf(
      Intent("com.android.settings.panel.action.MEDIA_OUTPUT")
        .putExtra("com.android.settings.panel.extra.PACKAGE_NAME", ctx.packageName),
      Intent(Settings.ACTION_BLUETOOTH_SETTINGS),
    )
    for (intent in attempts) {
      // Starting an Activity from a non-Activity context requires its own task.
      if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        launchCtx.startActivity(intent)
        return true
      } catch (_: Exception) {
        // unsupported on this device - try the next fallback
      }
    }
    return false
  }

  /** Connect (once) the module's MediaController; [done] runs on the main thread. The
   * connection hint marks it as the app's own controller (see [PlayerBridge.HINT_APP]). */
  private fun connect(done: (Exception?) -> Unit) {
    if (controller != null) {
      done(null)
      return
    }
    connectWaiters.add(done)
    if (controllerFuture != null) return
    val ctx = appContext.reactContext
    if (ctx == null) {
      val waiters = connectWaiters.toList()
      connectWaiters.clear()
      waiters.forEach { it(IllegalStateException("React context is not available")) }
      return
    }
    val token = SessionToken(ctx, ComponentName(ctx, AudiosiloPlayerService::class.java))
    val hints = Bundle().apply { putBoolean(PlayerBridge.HINT_APP, true) }
    val future = MediaController.Builder(ctx, token).setConnectionHints(hints).buildAsync()
    controllerFuture = future
    future.addListener({
      val waiters = connectWaiters.toList()
      connectWaiters.clear()
      try {
        val c = future.get()
        controller = c
        // A (re)connected controller may front a freshly created ExoPlayer at full
        // volume; re-assert the last requested gain so a fade isn't undone by a
        // service restart.
        c.volume = lastVolume
        lastEffects?.let { sendEffects(c, it) }
        attachListener(c)
        // The service may already hold a queue (the car started it, or JS restarted):
        // read its mapping from the items, not from a load this module never made.
        timelineMap = timelineOf(c.mediaItems())
        // The loop is play-state-driven (onIsPlayingChanged). If we reconnected to a
        // service that is already playing, kick it off now since no transition will fire.
        if (c.isPlaying) startProgressLoop()
        waiters.forEach { it(null) }
      } catch (e: Exception) {
        controllerFuture = null
        waiters.forEach { it(e) }
      }
    }, ContextCompat.getMainExecutor(ctx))
  }

  private fun sendEffects(c: MediaController, effects: Pair<Boolean, Boolean>) {
    val args = Bundle().apply {
      putBoolean("smartSpeed", effects.first)
      putBoolean("voiceBoost", effects.second)
    }
    c.sendCustomCommand(SessionCommand(CMD_SET_EFFECTS, Bundle.EMPTY), args)
  }

  private fun timelineOf(items: List<MediaItem>): TimelineMap = TimelineMap(
    items.mapIndexed { i, item ->
      MediaItems.entryOf(item) ?: TimelineMap.Entry(i, 0.0, 0.0, 0.0, clip = false)
    },
  )

  private fun attachListener(c: MediaController) {
    c.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(playbackState: Int) = emitState()
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        emitState()
        // Tick progress only while actually playing - a paused audiobook can sit for hours,
        // and emitting every second wakes JS for no position change (battery). Emit one
        // final sample on pause; paused seeks still report via onPositionDiscontinuity.
        if (isPlaying) startProgressLoop() else {
          emitProgress()
          stopProgressLoop()
        }
      }
      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = emitState()
      override fun onTimelineChanged(timeline: Timeline, reason: Int) {
        // A queue set by anyone (this module, the car, playback resumption): its items carry
        // their file mapping. A SOURCE_UPDATE (a duration resolved) leaves the items, and so the
        // mapping, as they were.
        if (reason != Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) return
        timelineMap = timelineOf(c.mediaItems())
      }
      override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
      ) {
        // Smart Speed skips a silence several times a minute; each is a discontinuity. They
        // only happen while playing, when the 1 s loop already reports the position, so a
        // sample per skip would just wake JS for nothing.
        if (reason == Player.DISCONTINUITY_REASON_SILENCE_SKIP) return
        emitProgress()
        flushRemoteMove()
      }
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        // Report the FILE index. In chapter mode several consecutive items belong to the
        // same file; emitTrackChange dedupes, so this only fires when the file changes.
        emitTrackChange(timelineMap.itemToFile(c.currentMediaItemIndex, 0L).first)
      }

      override fun onPlayerError(error: PlaybackException) {
        sendEvent("onState", mapOf("state" to "error"))
      }
    })
  }

  private fun dropRemoteMove() {
    handler.removeCallbacks(remoteMoveFallback)
    pendingRemoteMove = null
  }

  private fun flushRemoteMove() {
    handler.removeCallbacks(remoteMoveFallback)
    val move = pendingRemoteMove ?: return
    pendingRemoteMove = null
    sendEvent("onRemoteMove", mapOf("trackIndex" to move.first, "position" to move.second))
  }

  private fun emitState() {
    val c = controller ?: return
    val state = when (c.playbackState) {
      Player.STATE_BUFFERING -> "loading"
      Player.STATE_READY -> if (c.isPlaying) "playing" else "paused"
      Player.STATE_ENDED -> "ended"
      else -> "idle"
    }
    sendEvent("onState", mapOf("state" to state))
  }

  private fun emitTrackChange(index: Int) {
    if (index >= 0 && index != lastTrackIndex) {
      lastTrackIndex = index
      sendEvent("onTrackChange", mapOf("index" to index))
    }
  }

  /** Emit one progress sample (file-relative position + FILE duration + Smart Speed's saved
   * seconds). Safe to call in any state; driven by the play-time loop and by
   * onPositionDiscontinuity (paused seeks). */
  private fun emitProgress() {
    val c = controller ?: return
    if (c.mediaItemCount == 0) return
    val map = timelineMap
    val item = c.currentMediaItemIndex
    // Clips: translate the engine's clip position back to a file-relative position + the FILE
    // duration, so the JS store's file-based timeline math is unchanged.
    val position = if (map.clipped) map.itemToFile(item, c.currentPosition).second else c.currentPosition / 1000.0
    val duration = if (!map.clipped && c.duration > 0) c.duration / 1000.0 else map.fileDurationAt(item)
    sendEvent(
      "onProgress",
      mapOf("position" to position, "duration" to duration, "silenceSaved" to AudioEffects.silenceSavedSeconds),
    )
  }

  private fun startProgressLoop() {
    stopProgressLoop()
    val runnable = object : Runnable {
      override fun run() {
        emitProgress()
        handler.postDelayed(this, 1000)
      }
    }
    progressRunnable = runnable
    handler.post(runnable) // emit immediately, then every second while playing
  }

  private fun stopProgressLoop() {
    progressRunnable?.let { handler.removeCallbacks(it) }
    progressRunnable = null
  }

  private fun releaseController() {
    stopProgressLoop()
    handler.removeCallbacks(remoteMoveFallback)
    controller?.release()
    controller = null
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
  }

  private companion object {
    /** A remote move is emitted at the controller's next discontinuity, or after this if
     * none comes (the service already moved; never lose the event). */
    const val REMOTE_MOVE_FALLBACK_MS = 300L
  }
}
