// The alarm at a `pair`'s `expires_at` (WearLink.armPrune): drops the pair from the Data Layer with
// the app idle, so a pairing token never sits there past its life while the watch is away (fe#286).
// The token is already dead on the server by then; this only keeps it from lingering. Not exported:
// only this app's own alarm sends it. A sweep that did not finish (the Data Layer not answering,
// as just after a boot) sets a retry alarm (`WearRules.pruneRetryDelayMs`, fe#285), and a boot
// sets the alarm again (PairPruneBootReceiver: alarms do not outlive one).
package expo.modules.audiosilowatch

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class PairPruneReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    sweep(context, this, intent.getIntExtra(EXTRA_ATTEMPT, 0))
  }

  companion object {
    /** Inside a receiver's time to finish (10 s): what is not done waits for the retry or the next start. */
    private const val LIMIT_MS = 9_000L

    /** Which retry this alarm is (0: the alarm at an expiry, or a boot). */
    private const val EXTRA_ATTEMPT = "attempt"

    /**
     * The one alarm's intent (set again for each next expiry or retry, cancelled with no pair held).
     * `attempt` 0 for the alarm at an expiry: FLAG_UPDATE_CURRENT drops a retry's count with it.
     */
    fun pending(context: Context, attempt: Int = 0): PendingIntent =
      PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, PairPruneReceiver::class.java).apply { if (attempt > 0) putExtra(EXTRA_ATTEMPT, attempt) },
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )

    /**
     * The sweep a prune alarm (try `attempt`) or a boot runs, within the receiver's time: drop the
     * pairs past their time and set the next alarm; one that did not finish sets the retry's.
     */
    fun sweep(context: Context, receiver: BroadcastReceiver, attempt: Int) {
      val app = context.applicationContext
      val result = receiver.goAsync()
      WearLink.scope.launch {
        var done = false
        try {
          done = withTimeoutOrNull(LIMIT_MS) { WearLink.pruneDue(app) } ?: false
        } finally {
          if (!done) WearLink.armRetry(app, attempt + 1)
          result.finish()
        }
      }
    }
  }
}
