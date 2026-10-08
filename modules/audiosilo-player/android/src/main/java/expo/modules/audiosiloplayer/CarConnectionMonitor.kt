package expo.modules.audiosiloplayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.Executors

/**
 * Whether the phone is projecting to a car (Android Auto) or runs as one (Automotive), without
 * the car-app library: the same contract `androidx.car.app.connection.CarConnection` reads (a
 * query of the host's `content://androidx.car.app.connection` provider, column
 * `CarConnectionState`: 0 none, 1 native, 2 projection; re-queried on the host's
 * `CAR_CONNECTION_UPDATED` broadcast).
 *
 * Why not only the browsing controller: Media3 only learns that a LEGACY controller (Android
 * Auto's) went away by a timeout ("doesn't send any command for a while",
 * `MediaSession.Callback.onDisconnected`), minutes after the car left. The connection state says
 * so at once. [state] is null when the provider can't be read (no Auto host installed, or not
 * visible); the service then falls back to its connected Auto controllers.
 */
class CarConnectionMonitor(private val context: Context, private val onChange: () -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor()
  private var receiver: BroadcastReceiver? = null

  /** True connected, false not connected, null unknown. Main thread. */
  var state: Boolean? = null
    private set

  fun start() {
    val r = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) = query()
    }
    receiver = r
    val filter = IntentFilter(ACTION_CAR_CONNECTION_UPDATED)
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        // Sent by the Auto host app (another package), so the receiver must be exported.
        context.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        context.registerReceiver(r, filter)
      }
    } catch (e: Exception) {
      Log.w(TAG, "Could not watch the car connection", e)
    }
    query()
  }

  fun stop() {
    receiver?.let {
      try {
        context.unregisterReceiver(it)
      } catch (_: Exception) {
      }
    }
    receiver = null
    io.shutdown()
  }

  private fun query() {
    if (io.isShutdown) return
    io.execute {
      val value: Boolean? = try {
        context.contentResolver.query(Uri.parse("content://$AUTHORITY"), arrayOf(COLUMN), null, null, null)
          ?.use { c ->
            if (!c.moveToNext()) null else {
              val idx = c.getColumnIndex(COLUMN)
              if (idx < 0) null else c.getInt(idx) != 0
            }
          }
      } catch (e: Exception) {
        null
      }
      main.post {
        if (value != state) {
          state = value
          onChange()
        }
      }
    }
  }

  private companion object {
    const val TAG = "AudiosiloCar"
    const val AUTHORITY = "androidx.car.app.connection"
    const val COLUMN = "CarConnectionState"
    const val ACTION_CAR_CONNECTION_UPDATED = "androidx.car.app.connection.action.CAR_CONNECTION_UPDATED"
  }
}
