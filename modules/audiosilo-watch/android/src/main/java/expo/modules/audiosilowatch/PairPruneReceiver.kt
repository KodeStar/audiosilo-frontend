// The alarm at a `pair`'s `expires_at` (WearLink.armPrune): drops the pair from the Data Layer with
// the app idle, so a pairing token never sits there past its life while the watch is away (fe#286).
// The token is already dead on the server by then; this only keeps it from lingering. Not exported:
// only this app's own alarm sends it.
package expo.modules.audiosilowatch

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class PairPruneReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    val result = goAsync()
    WearLink.scope.launch {
      try {
        withTimeoutOrNull(LIMIT_MS) { WearLink.pruneDue(app) }
      } finally {
        result.finish()
      }
    }
  }

  companion object {
    /** Inside a receiver's time to finish (10 s): what is not done waits for the next start. */
    private const val LIMIT_MS = 9_000L

    /** The one alarm's intent (set again for each next expiry, cancelled with no pair held). */
    fun pending(context: Context): PendingIntent =
      PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, PairPruneReceiver::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
  }
}
