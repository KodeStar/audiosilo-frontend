package expo.modules.audiosiloplayer

import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
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

    val player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(mediaSourceFactory)
      .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
      .setHandleAudioBecomingNoisy(true)
      .setSeekForwardIncrementMs(30_000)
      .setSeekBackIncrementMs(15_000)
      .build()

    // Authenticated artwork loader (uses the same headers as the stream).
    val bitmapLoader = CacheBitmapLoader(
      DataSourceBitmapLoader(
        MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor()),
        dataSourceFactory,
      ),
    )

    mediaSession = MediaSession.Builder(this, player)
      .setBitmapLoader(bitmapLoader)
      .build()
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
