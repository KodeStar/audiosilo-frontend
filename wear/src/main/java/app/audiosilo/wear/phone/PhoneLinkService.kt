// The one WearableListenerService (W4 plan, "The Data Layer contract"): GMS starts the app for a
// change to an item under `/audiosilo/v1/to/` (the manifest's filter) even when it was swiped away
// or never opened. It hands the events to PhoneLink and returns once they are handled, so the
// process lives through the sign-in or the book's hold; a kill meanwhile leaves the item without
// its receipt, and the next start's read handles it again.
package app.audiosilo.wear.phone

import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

class PhoneLinkService : WearableListenerService() {
  override fun onDataChanged(buffer: DataEventBuffer) {
    val events = PhoneLink.onBuffer(buffer) ?: return
    // Off the main thread already (GMS calls back on its own); bounded so a stuck call can't hold it.
    runBlocking { withTimeoutOrNull(WAKE_LIMIT_MS) { PhoneLink.onEvents(this@PhoneLinkService, events) } }
  }

  private companion object {
    const val WAKE_LIMIT_MS = 60_000L
  }
}
