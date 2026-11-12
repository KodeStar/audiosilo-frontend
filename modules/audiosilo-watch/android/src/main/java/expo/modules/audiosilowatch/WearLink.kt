// The phone's ONE user of the Wear Data Layer (nothing else in the app may put or delete under
// `/audiosilo/v1/`): `pair`, `book` and `remove` out as DataItems, the watch's `watch-state` and
// `taken` receipts in. The other end is wear/.../phone/PhoneLink.kt; the rules are WearRules.kt
// (pure, tested), the messages are built in src/watch/watch-model.ts. The Data Layer carries only
// these: the watch talks to the server itself, so there is no sync relay here.
//
// Two ways in, as on the watch: WearLinkService (Play services starts the app for a receipt or a
// `watch-state` even when it is not running) and, while the app runs, the DataClient and
// CapabilityClient listeners registered at module creation. Both hand their events to `onEvents`.
// Receipts, prunes and sends run one at a time under `lock`, so a send never races the delete of
// the item it replaces.
package expo.modules.audiosilowatch

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.wear.remote.interactions.RemoteActivityHelper
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ExecutionException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull

/** No watch with the app (or no Data Layer at all): nothing was sent. */
class NoWatchException : Exception("No paired watch with the app installed")

/** Not a `v: 1` `pair`, `book` or `remove` with a `sent_at`: nothing was sent. */
class BadMessageException : Exception("Not a message the watch takes")

object WearLink {
  private const val TAG = "AudiosiloWearLink"
  private const val PREFS = "audiosilo.watch"
  private const val STATE_SEEN = "stateSeenAt."

  /** How long a question waits for the Data Layer before answering "no watch", never hanging. */
  private const val WAIT_MS = 5_000L

  /** One change, copied out of the event buffer before Play services releases it. */
  class Event(val deleted: Boolean, val node: String, val path: String, val bytes: ByteArray?)

  /** One Data Layer item and the node that put it. */
  private class Read(val node: String, val item: Item)

  val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val lock = Mutex()
  private val observers = CopyOnWriteArraySet<() -> Unit>()

  @Volatile private var localNode: String? = null
  private var started = false
  private lateinit var app: Context

  private val dataListener =
    DataClient.OnDataChangedListener { buffer ->
      val events = freeze(buffer)
      if (events.isNotEmpty()) scope.launch { onEvents(app, events) }
    }

  private val capabilityListener = CapabilityClient.OnCapabilityChangedListener { notifyChanged() }

  /** Play services is on this phone (the Data Layer may still be missing: `snapshot` says so). */
  fun supported(context: Context): Boolean =
    try {
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    } catch (e: Exception) {
      false
    }

  /** At module creation: listen while the app runs, and settle what came while it did not. */
  fun start(context: Context) {
    synchronized(this) {
      if (started) return
      started = true
      app = context.applicationContext
    }
    try {
      Wearable.getDataClient(app).addListener(dataListener, Uri.parse("wear://*" + WearPaths.ROOT), DataClient.FILTER_PREFIX)
      Wearable.getCapabilityClient(app).addListener(capabilityListener, WearPaths.WEAR_CAPABILITY)
    } catch (e: Exception) {
      Log.w(TAG, "no Data Layer listener", e)
    }
    scope.launch { sweep(app) }
  }

  /** Told when anything the snapshot says may have changed. Returns the way to stop. */
  fun observe(observer: () -> Unit): () -> Unit {
    observers.add(observer)
    return { observers.remove(observer) }
  }

  private fun notifyChanged() = observers.forEach { it() }

  fun freeze(buffer: DataEventBuffer): List<Event> =
    buffer.mapNotNull { e ->
      val uri = e.dataItem.uri
      val path = uri.path ?: return@mapNotNull null
      val deleted = e.type == DataEvent.TYPE_DELETED
      Event(deleted, uri.host ?: "", path, if (deleted) null else e.dataItem.data)
    }

  /** Changes from either way in: note who put a `watch-state`, act on receipts, then tell JS. */
  suspend fun onEvents(context: Context, events: List<Event>) {
    for (e in events) {
      try {
        when {
          e.path == WearPaths.WATCH_STATE && !e.deleted -> noteStateSeen(context, e.node)
          !e.deleted && WearPaths.isTaken(e.path, e.node) -> {
            val receipt = WearRules.receipt(Json.decodeObject(e.bytes)) ?: continue
            lock.withLock { settle(context, e.node, e.path, receipt, null) }
          }
        }
      } catch (x: CancellationException) {
        throw x
      } catch (x: Exception) {
        Log.w(TAG, "event ${e.path} not handled", x)
      }
    }
    notifyChanged()
  }

  /**
   * At start: drop the pairs past their time, and act on every receipt waiting (one put while no
   * process ran and the service was not started, or one the last process died on).
   */
  private suspend fun sweep(context: Context) {
    try {
      lock.withLock {
        val me = me(context) ?: return@withLock
        val own = ownItems(context, me)
        drop(context, me, WearRules.stalePairs(own, System.currentTimeMillis()))
        for (r in read(context, Uri.parse("wear://*" + WearPaths.ROOT + "from/"), prefix = true)) {
          val receipt = WearRules.receipt(r.item.payload) ?: continue
          settle(context, r.node, r.item.path, receipt, own)
        }
      }
    } catch (x: CancellationException) {
      throw x
    } catch (x: Exception) {
      Log.w(TAG, "sweep failed", x)
    }
    notifyChanged()
  }

  /** Delete the phone's item a receipt names, if it still holds that very send. Under `lock`. */
  private suspend fun settle(context: Context, node: String, receiptPath: String, receipt: Receipt, own: List<Item>?) {
    val me = me(context) ?: return
    val held =
      own?.firstOrNull { it.path == receipt.path }
        ?: if (own == null) read(context, Uri.parse("wear://$me${receipt.path}"), prefix = false).firstOrNull()?.item else null
    val path = WearRules.deletable(receiptPath, node, receipt, held) ?: return
    drop(context, me, listOf(path))
  }

  /** What `getSnapshot` answers, the expired pairs dropped first. "No watch" after `WAIT_MS`. */
  suspend fun snapshot(context: Context): Map<String, Any?> {
    val view =
      try {
        withTimeoutOrNull(WAIT_MS) { lock.withLock { view(context, pruneAt = System.currentTimeMillis()) } }
      } catch (x: CancellationException) {
        throw x
      } catch (x: Exception) {
        Log.w(TAG, "snapshot failed", x)
        null
      }
    return WearRules.snapshot(view ?: LinkView.NONE)
  }

  /**
   * Put a message for the target watch. A `pair` takes the place of any other pair held (one watch
   * at a time, and its token is the one that counts). Answers once the Data Layer holds the item:
   * the watch takes it when it is in reach, with the app closed, a `pair` ahead of the books.
   */
  suspend fun send(context: Context, message: Map<String, Any?>) {
    if (WearRules.pathFor(message, "check") == null) throw BadMessageException()
    lock.withLock {
      val now = System.currentTimeMillis()
      val view = withTimeoutOrNull(WAIT_MS) { view(context, pruneAt = now) } ?: throw NoWatchException()
      val target = WearRules.target(view) ?: throw NoWatchException()
      val path = WearRules.pathFor(message, target) ?: throw BadMessageException()
      val me = me(context) ?: throw NoWatchException()
      if (message["type"] == "pair") drop(context, me, WearRules.stalePairs(view.own, now, sendingTo = target))
      val put = PutDataRequest.create(path).setData(Json.encode(message).toByteArray(Charsets.UTF_8)).setUrgent()
      Wearable.getDataClient(context).putDataItem(put).await()
    }
    notifyChanged()
  }

  /** Open AudioSilo's Play listing on every connected watch (the same package as the phone's). */
  suspend fun openInstallOnWatch(context: Context) {
    val intent =
      Intent(Intent.ACTION_VIEW)
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setData(Uri.parse("market://details?id=${context.packageName}"))
    // Null node: every connected watch (from a phone).
    val future = RemoteActivityHelper(context.applicationContext, Dispatchers.IO.asExecutor()).startRemoteActivity(intent, null)
    suspendCancellableCoroutine { cont ->
      future.addListener(
        {
          try {
            future.get()
            cont.resume(Unit)
          } catch (e: ExecutionException) {
            cont.resumeWithException(e.cause ?: e)
          } catch (e: Exception) {
            cont.resumeWithException(e)
          }
        },
        Runnable::run,
      )
    }
  }

  /** Everything the snapshot is made of. Under `lock`; drops the stale pairs it finds when asked. */
  private suspend fun view(context: Context, pruneAt: Long?): LinkView {
    val data = Wearable.getDataClient(context)
    try {
      GoogleApiAvailability.getInstance().checkApiAvailability(data).await()
    } catch (x: CancellationException) {
      throw x
    } catch (x: Exception) {
      // No Wear OS app on the phone, or Play services too old: no watch to talk to.
      return LinkView.NONE
    }
    val me = me(context) ?: return LinkView.NONE
    val connected = Wearable.getNodeClient(context).connectedNodes.await().map { WatchNode(it.id, it.isNearby) }
    val capable =
      Wearable.getCapabilityClient(context)
        .getCapability(WearPaths.WEAR_CAPABILITY, CapabilityClient.FILTER_ALL)
        .await()
        .nodes
        .map { it.id }
        .toSet()
    val states =
      read(context, Uri.parse("wear://*" + WearPaths.WATCH_STATE), prefix = false)
        .filter { it.node != me }
        .mapNotNull { r -> r.item.payload?.let { r.node to it } }
        .toMap()
    var own = ownItems(context, me)
    if (pruneAt != null) {
      val stale = WearRules.stalePairs(own, pruneAt)
      drop(context, me, stale)
      own = own.filter { it.path !in stale }
    }
    return LinkView(true, connected, capable, states, stateSeen(context), own)
  }

  private suspend fun ownItems(context: Context, me: String): List<Item> =
    read(context, Uri.parse("wear://$me${WearPaths.ROOT}to/"), prefix = true).map { it.item }

  private suspend fun read(context: Context, uri: Uri, prefix: Boolean): List<Read> {
    val buffer =
      Wearable.getDataClient(context)
        .getDataItems(uri, if (prefix) DataClient.FILTER_PREFIX else DataClient.FILTER_LITERAL)
        .await()
    try {
      return buffer.mapNotNull { d ->
        val path = d.uri.path ?: return@mapNotNull null
        Read(d.uri.host ?: "", Item(path, Json.decodeObject(d.data)))
      }
    } finally {
      buffer.release()
    }
  }

  private suspend fun drop(context: Context, me: String, paths: List<String>) {
    val data = Wearable.getDataClient(context)
    for (path in paths) data.deleteDataItems(Uri.parse("wear://$me$path"), DataClient.FILTER_LITERAL).await()
  }

  private suspend fun me(context: Context): String? {
    localNode?.let { return it }
    return try {
      Wearable.getNodeClient(context).localNode.await().id.also { localNode = it }
    } catch (x: CancellationException) {
      throw x
    } catch (x: Exception) {
      Log.w(TAG, "no local node", x)
      null
    }
  }

  // Which watch spoke last, kept across launches for the target choice (WearRules.target).

  private fun noteStateSeen(context: Context, node: String) {
    if (node.isEmpty()) return
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putLong(STATE_SEEN + node, System.currentTimeMillis())
      .apply()
  }

  private fun stateSeen(context: Context): Map<String, Long> =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).all
      .filterKeys { it.startsWith(STATE_SEEN) }
      .mapNotNull { (k, v) -> (v as? Long)?.let { k.removePrefix(STATE_SEEN) to it } }
      .toMap()
}
