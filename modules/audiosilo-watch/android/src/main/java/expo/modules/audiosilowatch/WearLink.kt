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
import androidx.concurrent.futures.await
import androidx.wear.remote.interactions.RemoteActivityHelper
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import expo.modules.kotlin.exception.CodedException
import java.util.concurrent.CopyOnWriteArraySet
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull

// The codes are spelled out: one inferred from the class name would not survive R8's renaming.

/** No watch with the app (or no Data Layer at all): nothing was sent. JS gets `ERR_NO_WATCH`. */
class NoWatchException : CodedException("ERR_NO_WATCH", "No paired watch with the app installed", null)

/** Not a `v: 1` `pair`, `book` or `remove` with a `sent_at`: nothing was sent. `ERR_BAD_MESSAGE`. */
class BadMessageException : CodedException("ERR_BAD_MESSAGE", "The message is not one the watch takes", null)

/**
 * The Data Layer did not answer in time, so nothing is known of the watch: not the same as "no
 * watch". JS gets `ERR_NO_ANSWER` and keeps its last answer.
 */
class NoAnswerException : CodedException("ERR_NO_ANSWER", "The Data Layer did not answer", null)

object WearLink {
  private const val TAG = "AudiosiloWearLink"
  private const val PREFS = "audiosilo.watch"
  private const val STATE_SEEN = "stateSeenAt."

  /** How long a question waits for the Data Layer before giving up, never hanging. */
  private const val WAIT_MS = 5_000L

  /**
   * How long receipts or the sweep at start may hold `lock`: a Data Layer call that never answers
   * must not keep every send waiting behind it. What was not settled waits for the next start.
   */
  private const val HOLD_LIMIT_MS = 30_000L

  /** One change, copied out of the event buffer before Play services releases it. */
  class Event(val deleted: Boolean, val node: String, val path: String, val bytes: ByteArray?)

  /** One Data Layer item and the node that put it. */
  private class Read(val node: String, val item: Item)

  /** A watch's receipt: the node that put it, where, and what it says. */
  private class Taken(val node: String, val path: String, val receipt: Receipt)

  /** Any node's items at `path`. */
  private fun anyNode(path: String): Uri = Uri.parse("wear://*$path")

  /** The item node `node` put at `path` (the phone's own, to read or delete). */
  private fun nodeItem(node: String, path: String): Uri = Uri.parse("wear://$node$path")

  /** `block`'s answer, or null (and a log line) for anything it throws but a cancellation. */
  private inline fun <T> quietly(what: String, block: () -> T): T? =
    try {
      block()
    } catch (x: CancellationException) {
      throw x
    } catch (x: Exception) {
      Log.w(TAG, "$what failed", x)
      null
    }

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
      Wearable.getDataClient(app).addListener(dataListener, anyNode(WearPaths.ROOT), DataClient.FILTER_PREFIX)
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
    val changed = events.filter { !it.deleted }
    for (e in changed) if (e.path == WearPaths.WATCH_STATE) noteStateSeen(context, e.node)
    val taken =
      changed
        .filter { WearPaths.isTaken(it.path, it.node) }
        .mapNotNull { e -> WearRules.receipt(Json.decodeObject(e.bytes))?.let { Taken(e.node, e.path, it) } }
    if (taken.isNotEmpty()) {
      quietly("receipts") {
        withTimeoutOrNull(HOLD_LIMIT_MS) {
          lock.withLock {
            val me = me(context) ?: return@withLock
            settle(context, me, taken, ownItems(context, me))
          }
        }
      }
    }
    notifyChanged()
  }

  /**
   * At start: drop the pairs past their time, and act on every receipt waiting (one put while no
   * process ran and the service was not started, or one the last process died on).
   */
  private suspend fun sweep(context: Context) {
    quietly("sweep") {
      withTimeoutOrNull(HOLD_LIMIT_MS) {
        // A phone with no Wear OS app has nothing to settle (and no local node to ask for).
        if (!available(context)) return@withTimeoutOrNull
        lock.withLock {
          val me = me(context) ?: return@withLock
          val own = prune(context, me, ownItems(context, me), System.currentTimeMillis())
          val taken =
            read(context, anyNode(WearPaths.FROM), prefix = true).mapNotNull { r ->
              WearRules.receipt(r.item.payload)?.let { Taken(r.node, r.item.path, it) }
            }
          settle(context, me, taken, own)
        }
      }
    }
    notifyChanged()
  }

  /** Delete the phone's items these receipts name, where it still holds those very sends. Under `lock`. */
  private suspend fun settle(context: Context, me: String, taken: List<Taken>, own: List<Item>) {
    val held = own.associateBy { it.path }
    drop(context, me, taken.mapNotNull { WearRules.deletable(it.path, it.node, it.receipt, held[it.receipt.path]) })
  }

  /** Drop the pairs past their time at `now`; what is left of `own`. Under `lock`. */
  private suspend fun prune(context: Context, me: String, own: List<Item>, now: Long): List<Item> {
    val stale = WearRules.stalePairs(own, now)
    if (stale.isEmpty()) return own
    drop(context, me, stale)
    return own.filter { it.path !in stale }
  }

  /**
   * What `getSnapshot` answers, the expired pairs dropped first. "No watch" only where that is
   * known (no Wearable API on this phone). With no Data Layer answer within `WAIT_MS`, or a failed
   * one, it throws (NoAnswerException, or the error): nothing is known, and JS keeps its last answer
   * rather than taking a slow moment for a watch that has gone.
   */
  suspend fun snapshot(context: Context): Map<String, Any?> {
    val view = withTimeoutOrNull(WAIT_MS) { lock.withLock { view(context, System.currentTimeMillis()) } }
    return WearRules.snapshot(view ?: throw NoAnswerException())
  }

  /** `snapshot` for the `watchState` event: null (and a log line) when there is nothing to tell. */
  suspend fun snapshotOrNull(context: Context): Map<String, Any?>? = quietly("snapshot") { snapshot(context) }

  /**
   * Put a message for the target watch. A `pair` takes the place of any other pair held (one watch
   * at a time, and its token is the one that counts). Answers once the Data Layer holds the item:
   * the watch takes it when it is in reach, with the app closed, a `pair` ahead of the books.
   */
  suspend fun send(context: Context, message: Map<String, Any?>) {
    val slot = WearRules.slot(message) ?: throw BadMessageException()
    lock.withLock {
      val now = System.currentTimeMillis()
      val view = withTimeoutOrNull(WAIT_MS) { view(context, now) } ?: throw NoWatchException()
      val target = WearRules.target(view) ?: throw NoWatchException()
      val me = me(context) ?: throw NoWatchException()
      if (slot == WearPaths.PAIR) drop(context, me, WearRules.stalePairs(view.own, now, sendingTo = target))
      val put =
        PutDataRequest.create(WearPaths.to(target) + slot).setData(Json.encode(message).toByteArray(Charsets.UTF_8)).setUrgent()
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
    RemoteActivityHelper(context.applicationContext, Dispatchers.IO.asExecutor()).startRemoteActivity(intent, null).await()
  }

  /** Everything the snapshot is made of, the pairs past their time at `now` dropped. Under `lock`. */
  private suspend fun view(context: Context, now: Long): LinkView {
    if (!available(context)) return LinkView.NONE
    val me = me(context) ?: throw NoAnswerException()
    // Four questions that do not wait on each other: asked together, the answer takes the slowest.
    return coroutineScope {
      val connected = async { Wearable.getNodeClient(context).connectedNodes.await().map { WatchNode(it.id, it.isNearby) } }
      val capable = async {
        Wearable.getCapabilityClient(context)
          .getCapability(WearPaths.WEAR_CAPABILITY, CapabilityClient.FILTER_ALL)
          .await()
          .nodes
          .map { it.id }
          .toSet()
      }
      val states = async {
        read(context, anyNode(WearPaths.WATCH_STATE), prefix = false)
          .filter { it.node != me }
          .mapNotNull { r -> r.item.payload?.let { r.node to it } }
          .toMap()
      }
      val own = async { ownItems(context, me) }
      LinkView(true, connected.await(), capable.await(), states.await(), stateSeen(context), prune(context, me, own.await(), now))
    }
  }

  /** The Wearable API answers here. No Wear OS app on the phone, or Play services too old: no watch to talk to. */
  private suspend fun available(context: Context): Boolean =
    try {
      GoogleApiAvailability.getInstance().checkApiAvailability(Wearable.getDataClient(context)).await()
      true
    } catch (x: CancellationException) {
      throw x
    } catch (x: Exception) {
      false
    }

  private suspend fun ownItems(context: Context, me: String): List<Item> =
    read(context, nodeItem(me, WearPaths.TO), prefix = true).map { it.item }

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
    for (path in paths) data.deleteDataItems(nodeItem(me, path), DataClient.FILTER_LITERAL).await()
  }

  private suspend fun me(context: Context): String? {
    localNode?.let { return it }
    return quietly("local node") { Wearable.getNodeClient(context).localNode.await().id.also { localNode = it } }
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
