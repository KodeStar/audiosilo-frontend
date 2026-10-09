package expo.modules.audiosiloplayer

import android.content.Intent
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaButtonReceiver

/**
 * Media3's media button receiver (playback resumption: a Bluetooth/headset play, or the car's
 * play button, while no session is running), with one guard. The receiver starts the service
 * as a FOREGROUND service, and the service must then start playback within seconds or the system
 * kills the app (`ForegroundServiceDidNotStartInTimeException`). We can only resume a book the
 * car snapshot can start without JS (a downloaded book with a play spec, see
 * [CarSnapshot.resumable]); with none, the press is ignored instead of crashing.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class ResumptionReceiver : MediaButtonReceiver() {
  override fun shouldStartForegroundService(intent: Intent): Boolean {
    val context = CarSnapshotStore.appContext ?: return false
    return CarSnapshotStore.get(context)?.resumable() != null
  }
}
