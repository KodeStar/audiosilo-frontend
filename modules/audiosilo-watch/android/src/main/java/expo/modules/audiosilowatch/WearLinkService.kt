// The phone's one WearableListenerService: Play services starts the app for a watch's `taken`
// receipt or its `watch-state` (the manifest's filter) even when the app is not running, so the
// phone deletes the items the watch has taken without waiting to be opened. It hands the events to
// WearLink and returns once they are handled; a kill meanwhile leaves the receipt, and the next
// start's sweep acts on it.
package expo.modules.audiosilowatch

import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

class WearLinkService : WearableListenerService() {
  override fun onDataChanged(buffer: DataEventBuffer) {
    val events = WearLink.freeze(buffer)
    if (events.isEmpty()) return
    // Play services calls back off the main thread; bounded so a stuck call can't hold it.
    runBlocking { withTimeoutOrNull(WAKE_LIMIT_MS) { WearLink.onEvents(this@WearLinkService, events) } }
  }

  private companion object {
    const val WAKE_LIMIT_MS = 30_000L
  }
}
