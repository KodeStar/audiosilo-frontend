// The watch's side of the Data Layer contract (W4 plan, "The Data Layer contract", with the receipt
// changes in ship-notes): the ONLY code that reads the phone's `/audiosilo/v1/to/<me>/` items or
// puts this watch's items (`watch-state`, the `taken` receipts). Two ways in, one path through:
//  - PhoneLinkService, the one WearableListenerService: GMS starts the app for a change to an
//    item under `/audiosilo/v1/to/` even when it was swiped away or never opened;
//  - the running app's DataClient listener (registered for the process's life), so a change while
//    it runs needs no service bind.
// Both hand the frozen events to `onEvents`, which handles one at a time under a lock; an item
// already handled in this process (the service and the listener both saw it) or named by its
// receipt is skipped (PhoneInbox). At every start (the process, and each return to the foreground)
// all of `/to/<me>/` is read: an item put before install fires no change event.
//
// For an item it takes, AppModel.receive keeps its effect first (sign-in, HeldBooks, removal),
// then the receipt is put; the phone deletes its own item on seeing it, and the watch deletes its
// receipt once that item is gone. The watch never deletes the phone's items, and a DELETED under
// `/to/<me>/` is never an instruction (uninstalling the phone app deletes its items).
package app.audiosilo.wear.phone

import android.content.Context
import android.net.Uri
import android.util.Log
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.core.DataPaths
import app.audiosilo.wear.core.InboxItem
import app.audiosilo.wear.core.PhoneInbox
import app.audiosilo.wear.core.PhoneMessages
import app.audiosilo.wear.core.TakenReceipt
import app.audiosilo.wear.core.WatchState
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await

object PhoneLink {
  private const val TAG = "AudioSiloPhoneLink"

  /** One change as the listener saw it, copied out of the event buffer before it is released. */
  class Event(val deleted: Boolean, val item: InboxItem)

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val lock = Mutex()

  /** One `watch-state` put at a time, always the latest owed: an older one never lands last. */
  private val stateLock = Mutex()

  @Volatile private var node: String? = null
  private var started = false

  /** `path|sent_at` of the items handled in this process (the two ways in see each change). */
  private val handled = LinkedHashSet<String>()

  private lateinit var appContext: Context

  private val live =
    DataClient.OnDataChangedListener { buffer ->
      val events = onBuffer(buffer) ?: return@OnDataChangedListener
      scope.launch { onEvents(appContext, events) }
    }

  /** At process start (AudioSiloApp): wire `watch-state`, listen while running, read what waits. */
  fun start(context: Context) {
    synchronized(this) {
      if (started) return
      started = true
    }
    appContext = context.applicationContext
    val model = AppModel.get(context)
    model.onState = { scope.launch { sendState(appContext) } }
    try {
      Wearable.getDataClient(appContext).addListener(live, Uri.parse("wear://*" + DataPaths.ROOT), DataClient.FILTER_PREFIX)
    } catch (e: Exception) {
      Log.w(TAG, "no Data Layer listener", e)
    }
    scope.launch { sweep(appContext) }
  }

  /** Each return to the foreground: read what waits again and send a state still owed. */
  fun onForeground(context: Context) {
    scope.launch { sweep(context.applicationContext) }
  }

  /** The events of one callback, frozen (null when there is nothing for this watch). */
  fun onBuffer(buffer: DataEventBuffer): List<Event>? {
    val events =
      buffer.mapNotNull { e ->
        val item = e.dataItem
        val path = item.uri.path ?: return@mapNotNull null
        if (!path.startsWith(DataPaths.TO_ROOT)) return@mapNotNull null
        Event(e.type == DataEvent.TYPE_DELETED, InboxItem(path, if (e.type == DataEvent.TYPE_DELETED) null else item.data))
      }
    return events.ifEmpty { null }
  }

  /** Handle changes from either way in, one at a time. */
  suspend fun onEvents(context: Context, events: List<Event>) {
    val me = node(context) ?: return
    lock.withLock {
      for (e in events) {
        try {
          if (e.deleted) afterDelete(context, me, e.item.path) else changed(context, me, e.item)
        } catch (x: CancellationException) {
          throw x
        } catch (x: Exception) {
          Log.w(TAG, "event ${e.item.path} not handled", x)
        }
      }
    }
  }

  private suspend fun changed(context: Context, me: String, item: InboxItem) {
    if (seenKey(item) in handled) return
    val receipt = readReceipt(context, me, item.path)
    if (!PhoneInbox.handles(me, item, receipt)) return
    take(context, me, item)
  }

  private suspend fun afterDelete(context: Context, me: String, path: String) {
    val receipt = readReceipt(context, me, path) ?: return
    val present = items(context, Uri.parse("wear://*$path"), exact = true).associate { it.path to it.sentAt }
    val drop = PhoneInbox.afterDelete(me, path, receipt, present) ?: return
    deleteOwn(context, me, drop)
  }

  /** Keep the item's effect (AppModel, in order), then put its receipt. An unknown message gets none. */
  private suspend fun take(context: Context, me: String, item: InboxItem) {
    val message = PhoneMessages.decodeBytes(item.bytes) ?: return
    AppModel.get(context).receive(message)
    remember(seenKey(item))
    val receipt = TakenReceipt.of(item.path, item.bytes) ?: return
    val put = PutDataRequest.create(DataPaths.taken(me, item.path)).setData(PhoneMessages.encodeBytes(receipt)).setUrgent()
    Wearable.getDataClient(context).putDataItem(put).await()
  }

  private fun seenKey(item: InboxItem): String = "${item.path}|${item.sentAt}"

  private fun remember(key: String) {
    handled.add(key)
    while (handled.size > MAX_HANDLED) handled.remove(handled.first())
  }

  /** Read everything addressed here and every receipt: handle what no receipt names, drop settled receipts. */
  private suspend fun sweep(context: Context) {
    sendState(context)
    val me = node(context) ?: return
    lock.withLock {
      try {
        val items = items(context, Uri.parse("wear://*" + DataPaths.to(me)), exact = false)
        val receipts = items(context, Uri.parse("wear://$me" + DataPaths.takenPrefix(me)), exact = false)
        val plan = PhoneInbox.sweep(me, items, receipts)
        for (item in plan.handle) {
          try {
            take(context, me, item)
          } catch (x: CancellationException) {
            throw x
          } catch (x: Exception) {
            Log.w(TAG, "item ${item.path} not handled", x)
          }
        }
        for (path in plan.dropReceipts) deleteOwn(context, me, path)
      } catch (x: CancellationException) {
        throw x
      } catch (x: Exception) {
        Log.w(TAG, "sweep failed", x)
      }
    }
  }

  private suspend fun items(context: Context, uri: Uri, exact: Boolean): List<InboxItem> {
    val buffer = Wearable.getDataClient(context).getDataItems(uri, if (exact) DataClient.FILTER_LITERAL else DataClient.FILTER_PREFIX).await()
    try {
      return buffer.mapNotNull { d: DataItem -> d.uri.path?.let { InboxItem(it, d.data) } }
    } finally {
      buffer.release()
    }
  }

  private suspend fun readReceipt(context: Context, me: String, itemPath: String): TakenReceipt? {
    val uri = Uri.parse("wear://$me" + DataPaths.taken(me, itemPath))
    val found = items(context, uri, exact = true).firstOrNull() ?: return null
    return PhoneMessages.decodeReceipt(found.bytes)
  }

  private suspend fun deleteOwn(context: Context, me: String, path: String) {
    Wearable.getDataClient(context).deleteDataItems(Uri.parse("wear://$me$path"), DataClient.FILTER_LITERAL).await()
  }

  // watch-state

  /**
   * Put the state the phone is owed, if any (a change, a start, a return to the foreground). A put
   * refused stays owed for the next of those moments; no timer.
   */
  private suspend fun sendState(context: Context) {
    val publication = AppModel.get(context).statePublication
    stateLock.withLock {
      val state: WatchState = publication.due ?: return
      try {
        val put = PutDataRequest.create(DataPaths.WATCH_STATE).setData(PhoneMessages.encodeBytes(state)).setUrgent()
        Wearable.getDataClient(context).putDataItem(put).await()
        publication.tookIt(state)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        Log.w(TAG, "watch-state not put", e)
      }
    }
  }

  private suspend fun node(context: Context): String? {
    node?.let { return it }
    return try {
      Wearable.getNodeClient(context).localNode.await().id.also { node = it }
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.w(TAG, "no local node", e)
      null
    }
  }

  private const val MAX_HANDLED = 200
}
