// A boot (or this app's update) drops every alarm, the pair prune's too (fe#285): with a pair still
// held and the app not opened again, it would stay in the Data Layer past its `expires_at`. The
// sweep runs again and sets the alarm (PairPruneReceiver.sweep). Exported for the system's
// broadcasts, which only the system sends; anything else is ignored. Enabled only while a prune is
// due (WearLink.armPrune), so a phone with no pair held is not woken at every boot.
package expo.modules.audiosilowatch

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class PairPruneBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!handles(intent.action)) return
    PairPruneReceiver.sweep(context, this, 0)
  }

  companion object {
    /** The broadcasts after which no alarm of this app is left. */
    val ACTIONS = setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)

    fun handles(action: String?): Boolean = action in ACTIONS
  }
}
