package expo.modules.audiosiloplayer

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
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
 * the clip within that file (endInFile <= 0 ⇒ to end of file).
 */
class ChapterRecord : Record {
  @Field var fileIndex: Int = 0
  @Field var startInFile: Double = 0.0
  @Field var endInFile: Double = 0.0
  @Field var title: String = ""
}

class ConfigRecord : Record {
  @Field var autoRewindMax: Double = 0.0
  @Field var jumpForward: Double = 30.0
  @Field var jumpBackward: Double = 15.0
}

/**
 * Translates between the chapter-clip media items the engine plays and the FILE-based
 * timeline the JS store works in. The store thinks in (fileIndex, positionInFile); each
 * engine media item is one chapter clip. This keeps the bridge contract unchanged while
 * the lock screen gets true chapter controls.
 */
private class ChapterMap(val clips: List<ChapterRecord>) {
  /** (fileIndex, seconds-within-file) → (clip item index, clip-relative ms). */
  fun fileToItem(fileIndex: Int, fileRelSec: Double): Pair<Int, Long> {
    var firstOfFile = -1
    for (i in clips.indices) {
      val c = clips[i]
      if (c.fileIndex != fileIndex) continue
      if (firstOfFile < 0) firstOfFile = i
      val end = if (c.endInFile > 0) c.endInFile else Double.MAX_VALUE
      if (fileRelSec >= c.startInFile && fileRelSec < end) {
        return Pair(i, (((fileRelSec - c.startInFile) * 1000).toLong()).coerceAtLeast(0L))
      }
    }
    // Position not inside any clip of that file (e.g. rounding past the last boundary):
    // land at the first clip of the file, else the very first clip.
    val idx = if (firstOfFile >= 0) firstOfFile else 0
    val start = clips.getOrNull(idx)?.startInFile ?: 0.0
    return Pair(idx, (((fileRelSec - start) * 1000).toLong()).coerceAtLeast(0L))
  }

  /** (clip item index, clip-relative ms) → (fileIndex, seconds-within-file). */
  fun itemToFile(itemIndex: Int, clipRelMs: Long): Pair<Int, Double> {
    val c = clips.getOrNull(itemIndex) ?: return Pair(itemIndex, clipRelMs / 1000.0)
    return Pair(c.fileIndex, c.startInFile + clipRelMs / 1000.0)
  }
}

/**
 * Bridges the JS playback API to a Media3 MediaSessionService via a MediaController.
 * Positions are reported per-FILE (seconds); the JS store maps them onto the whole-book
 * timeline. When chapters are supplied each chapter is a clipped media item, and this
 * module translates the engine's clip indices/positions back to file-relative ones so
 * the store's file-based math is unchanged. All controller access happens on the main
 * thread.
 */
class AudiosiloPlayerModule : Module() {
  private var controller: MediaController? = null
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private val handler = Handler(Looper.getMainLooper())
  private var progressRunnable: Runnable? = null
  private var lastTrackIndex: Int = -1
  /** Non-null when the current book is played as chapter clips (see ChapterMap). */
  private var chapterMap: ChapterMap? = null
  /** Per-file durations (seconds) from the loaded tracks, so progress can report the
   * FILE duration even when the engine's current item is a clip. */
  private var fileDurations: List<Double> = emptyList()

  private val context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  override fun definition() = ModuleDefinition {
    Name("AudiosiloPlayer")

    Events("onState", "onProgress", "onTrackChange")

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
      handler.post { connect(promise) }
    }

    AsyncFunction("setConfig") { config: ConfigRecord ->
      // Auto-rewind is applied natively (AudiobookPlayer) so it covers lock-screen resumes
      // too. The lock-screen 30s skip buttons use the player's fixed seek increments
      // (set on the ExoPlayer), so skip intervals aren't plumbed here.
      PlayerConfig.autoRewindMaxMs = (config.autoRewindMax * 1000).toLong()
    }

    AsyncFunction("load") { tracks: List<TrackRecord>, startIndex: Int, position: Double, chapters: List<ChapterRecord>? ->
      handler.post {
        val c = controller ?: return@post
        // Every track in a book shares the same auth header.
        AuthHolder.headers = tracks.firstOrNull()?.headers ?: emptyMap()
        lastTrackIndex = -1
        fileDurations = tracks.map { it.duration ?: 0.0 }
        val map = if (!chapters.isNullOrEmpty()) ChapterMap(chapters) else null
        chapterMap = map
        val items: List<MediaItem>
        val itemIndex: Int
        val itemPosMs: Long
        if (map != null) {
          items = map.clips.map { toClipItem(it, tracks) }
          val (idx, ms) = map.fileToItem(startIndex, position)
          itemIndex = idx
          itemPosMs = ms
        } else {
          items = tracks.map { toMediaItem(it) }
          itemIndex = startIndex
          itemPosMs = (position * 1000).toLong()
        }
        val safeIndex = itemIndex.coerceIn(0, maxOf(0, items.size - 1))
        c.setMediaItems(items, safeIndex, itemPosMs)
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
        val map = chapterMap
        if (map != null) {
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
        val map = chapterMap
        if (map != null) {
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

    AsyncFunction("reset") {
      handler.post {
        controller?.stop()
        controller?.clearMediaItems()
        lastTrackIndex = -1
        chapterMap = null
        fileDurations = emptyList()
        sendEvent("onState", mapOf("state" to "idle"))
      }
    }

    OnDestroy {
      handler.post { releaseController() }
    }
  }

  private fun connect(promise: Promise) {
    if (controller != null) {
      promise.resolve(null)
      return
    }
    val token = SessionToken(context, ComponentName(context, AudiosiloPlayerService::class.java))
    val future = MediaController.Builder(context, token).buildAsync()
    controllerFuture = future
    future.addListener({
      try {
        val c = future.get()
        controller = c
        attachListener(c)
        startProgressLoop()
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("ERR_MEDIA_CONTROLLER", "Failed to connect to media session", e)
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun attachListener(c: MediaController) {
    c.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(playbackState: Int) = emitState()
      override fun onIsPlayingChanged(isPlaying: Boolean) = emitState()
      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = emitState()
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        // Report the FILE index. In chapter mode several consecutive items belong to the
        // same file; emitTrackChange dedupes, so this only fires when the file changes.
        val map = chapterMap
        val fileIndex =
          if (map != null) map.itemToFile(c.currentMediaItemIndex, 0L).first
          else c.currentMediaItemIndex
        emitTrackChange(fileIndex)
      }

      override fun onPlayerError(error: PlaybackException) {
        sendEvent("onState", mapOf("state" to "error"))
      }
    })
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

  private fun startProgressLoop() {
    stopProgressLoop()
    val runnable = object : Runnable {
      override fun run() {
        controller?.let { c ->
          if (c.mediaItemCount > 0) {
            val map = chapterMap
            if (map != null) {
              // Translate the engine's clip position back to a file-relative position +
              // the FILE duration, so the JS store's file-based timeline math is unchanged.
              val (fileIndex, fileSec) = map.itemToFile(c.currentMediaItemIndex, c.currentPosition)
              val dur = fileDurations.getOrElse(fileIndex) { 0.0 }
              sendEvent("onProgress", mapOf("position" to fileSec, "duration" to dur))
            } else {
              val pos = c.currentPosition / 1000.0
              val dur = if (c.duration > 0) c.duration / 1000.0 else 0.0
              sendEvent("onProgress", mapOf("position" to pos, "duration" to dur))
            }
          }
        }
        handler.postDelayed(this, 1000)
      }
    }
    progressRunnable = runnable
    handler.postDelayed(runnable, 1000)
  }

  private fun stopProgressLoop() {
    progressRunnable?.let { handler.removeCallbacks(it) }
    progressRunnable = null
  }

  private fun toMediaItem(t: TrackRecord): MediaItem {
    val metadata = MediaMetadata.Builder()
      .setTitle(t.title)
      .setArtist(t.artist ?: "")
      .setAlbumTitle(t.album ?: t.title)
      .apply { t.artwork?.let { setArtworkUri(Uri.parse(it)) } }
      .build()
    return MediaItem.Builder()
      .setUri(t.url)
      .setMediaId(t.id)
      .setMediaMetadata(metadata)
      .build()
  }

  /** Build a clipped media item for one chapter: the file's URL clipped to the chapter's
   * in-file range, titled with the chapter (so the lock screen shows the chapter). */
  private fun toClipItem(clip: ChapterRecord, tracks: List<TrackRecord>): MediaItem {
    val t = tracks.getOrNull(clip.fileIndex) ?: tracks.first()
    val title = clip.title.ifEmpty { t.title }
    val metadata = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(t.artist ?: "")
      .setAlbumTitle(t.album ?: t.title)
      .apply { t.artwork?.let { setArtworkUri(Uri.parse(it)) } }
      .build()
    val clipping = MediaItem.ClippingConfiguration.Builder()
      .setStartPositionMs((clip.startInFile * 1000).toLong())
      .apply { if (clip.endInFile > 0) setEndPositionMs((clip.endInFile * 1000).toLong()) }
      .build()
    return MediaItem.Builder()
      .setUri(t.url)
      .setMediaId("${t.id}#${clip.startInFile}")
      .setMediaMetadata(metadata)
      .setClippingConfiguration(clipping)
      .build()
  }

  private fun releaseController() {
    stopProgressLoop()
    controller?.release()
    controller = null
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
  }
}
