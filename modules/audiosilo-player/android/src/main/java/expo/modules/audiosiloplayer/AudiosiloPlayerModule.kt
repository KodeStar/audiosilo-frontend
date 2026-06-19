package expo.modules.audiosiloplayer

import android.content.ComponentName
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

class ConfigRecord : Record {
  @Field var autoRewindMax: Double = 0.0
  @Field var jumpForward: Double = 30.0
  @Field var jumpBackward: Double = 15.0
}

/**
 * Bridges the JS playback API to a Media3 MediaSessionService via a MediaController.
 * Positions are reported per-track (seconds); the JS store maps them onto the
 * whole-book timeline. All controller access happens on the main thread.
 */
class AudiosiloPlayerModule : Module() {
  private var controller: MediaController? = null
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private val handler = Handler(Looper.getMainLooper())
  private var autoRewindMax: Double = 0.0
  private var pausedAt: Long = 0L
  private var progressRunnable: Runnable? = null
  private var lastTrackIndex: Int = -1

  private val context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  override fun definition() = ModuleDefinition {
    Name("AudiosiloPlayer")

    Events("onState", "onProgress", "onTrackChange")

    AsyncFunction("setup") { promise: Promise ->
      handler.post { connect(promise) }
    }

    AsyncFunction("setConfig") { config: ConfigRecord ->
      autoRewindMax = config.autoRewindMax
    }

    AsyncFunction("load") { tracks: List<TrackRecord>, startIndex: Int, position: Double ->
      handler.post {
        val c = controller ?: return@post
        // Every track in a book shares the same auth header.
        AuthHolder.headers = tracks.firstOrNull()?.headers ?: emptyMap()
        lastTrackIndex = -1
        c.setMediaItems(tracks.map { toMediaItem(it) }, startIndex, (position * 1000).toLong())
        c.prepare()
        emitTrackChange(startIndex)
      }
    }

    AsyncFunction("play") {
      handler.post {
        val c = controller ?: return@post
        if (autoRewindMax > 0 && pausedAt > 0L) {
          val elapsed = (System.currentTimeMillis() - pausedAt) / 1000.0
          val rewind = minOf(autoRewindMax, elapsed)
          if (rewind > 0.5) {
            c.seekTo(maxOf(0L, c.currentPosition - (rewind * 1000).toLong()))
          }
        }
        pausedAt = 0L
        c.play()
      }
    }

    AsyncFunction("pause") {
      handler.post {
        controller?.pause()
        pausedAt = System.currentTimeMillis()
      }
    }

    AsyncFunction("seekTo") { seconds: Double ->
      handler.post { controller?.seekTo((seconds * 1000).toLong()) }
    }

    AsyncFunction("skipToTrack") { index: Int, seconds: Double ->
      handler.post { controller?.seekTo(index, (seconds * 1000).toLong()) }
    }

    AsyncFunction("setRate") { rate: Double ->
      handler.post { controller?.setPlaybackParameters(PlaybackParameters(rate.toFloat(), 1.0f)) }
    }

    AsyncFunction("reset") {
      handler.post {
        controller?.stop()
        controller?.clearMediaItems()
        pausedAt = 0L
        lastTrackIndex = -1
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
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) =
        emitTrackChange(c.currentMediaItemIndex)

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
            val pos = c.currentPosition / 1000.0
            val dur = if (c.duration > 0) c.duration / 1000.0 else 0.0
            sendEvent("onProgress", mapOf("position" to pos, "duration" to dur))
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

  private fun releaseController() {
    stopProgressLoop()
    controller?.release()
    controller = null
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
  }
}
