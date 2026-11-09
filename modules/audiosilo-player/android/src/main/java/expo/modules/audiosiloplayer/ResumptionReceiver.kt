package expo.modules.audiosiloplayer

import android.content.Context
import android.content.Intent
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaButtonReceiver

/**
 * Media3's media button receiver (playback resumption: a Bluetooth/headset play, or the car's
 * play button, while no session is running), with one guard. The receiver starts the service
 * as a FOREGROUND service, and the service must then start playback within seconds or the system
 * kills the app (`ForegroundServiceDidNotStartInTimeException`). We can only resume a book the
 * car snapshot can start without JS (a downloaded book with a play spec, see
 * [CarSnapshot.resumable]); with none, the press is ignored instead of crashing. Should a
 * resumption still fail after the start, the service releases the start itself
 * ([AudiosiloPlayerService.watchResumption]).
 *
 * The override must match the Media3 the app RUNS (build.gradle's `media3Version`): 1.9.0 calls
 * only `shouldStartForegroundService(Context, Intent)`, and the 1.5.1 `(Intent)` one this class
 * used to override was silently never called.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class ResumptionReceiver : MediaButtonReceiver() {
  override fun shouldStartForegroundService(context: Context, intent: Intent): Boolean {
    CarSnapshotStore.init(context)
    return CarSnapshotStore.get(context)?.resumable() != null
  }
}
