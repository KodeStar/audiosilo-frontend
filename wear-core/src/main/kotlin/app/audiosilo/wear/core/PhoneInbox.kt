// What PhoneLink (the watch's one Data Layer listener) does with the items it sees, kept pure so
// the receipt contract is tested here (ship-notes, "Data Layer contract changes from check 5"):
//  - at every start it reads all of `/to/<me>/` and its own receipts: an item no receipt names
//    (path and `sent_at`) is handled, a receipt whose item is gone is dropped;
//  - a CHANGED item under `/to/<me>/` is handled unless its receipt already names it (the same
//    item seen again, by the running app's listener and the service both, or after a restart);
//  - a DELETED item under `/to/<me>/` is never an instruction (uninstalling the phone app deletes
//    its items), only the moment to drop the receipt that named it;
//  - anything addressed to another node is not this watch's.
// Handling is idempotent (a pair for the account signed in changes nothing, a book is held once, a
// remove older than the download is ignored), so an item handled twice after a kill does no harm.
package app.audiosilo.wear.core

/** One DataItem as the listener read it: its path and its bytes. */
class InboxItem(val path: String, val bytes: ByteArray?) {
  /** Its `sent_at` as the phone wrote it (the receipt echoes this text). */
  val sentAt: String?
    get() = PhoneMessages.objectOf(bytes)?.let(PhoneMessages::sentAtText)

  override fun equals(other: Any?): Boolean =
    other is InboxItem && other.path == path && (bytes?.contentEquals(other.bytes) ?: (other.bytes == null))

  override fun hashCode(): Int = path.hashCode() * 31 + (bytes?.contentHashCode() ?: 0)

  override fun toString(): String = "InboxItem($path)"
}

object PhoneInbox {
  /** What a start's read of the Data Layer leads to. */
  data class Sweep(
    /** The items to hand to the app, the `pair` first, then the books by `sent_at`. */
    val handle: List<InboxItem>,
    /** The receipt paths to delete (their items are gone, or replaced by a newer send). */
    val dropReceipts: List<String>,
  )

  /**
   * At a start: `items`, everything listed under `/to/<node>/`; `receipts`, everything listed under
   * this watch's `/from/<node>/taken/`.
   */
  fun sweep(node: String, items: List<InboxItem>, receipts: List<InboxItem>): Sweep {
    val mine = items.filter { DataPaths.addressed(it.path, node) != null }
    val kept = receipts.filter { DataPaths.isTaken(it.path, node) }.mapNotNull { r -> PhoneMessages.decodeReceipt(r.bytes)?.let { r.path to it } }
    val present = mine.associate { it.path to it.sentAt }
    val handle = mine.filter { item -> kept.none { (_, receipt) -> receipt.names(item.path, item.sentAt) } }
    val drop = kept.filter { (_, receipt) -> TakenReceipt.settled(receipt, present) }.map { it.first }
    return Sweep(ordered(node, handle), drop)
  }

  /**
   * A CHANGED event for `item`: whether to hand it to the app. `receipt` is this watch's receipt
   * for that path, if one is there.
   */
  fun handles(node: String, item: InboxItem, receipt: TakenReceipt?): Boolean {
    if (DataPaths.addressed(item.path, node) == null) return false
    return receipt?.names(item.path, item.sentAt) != true
  }

  /**
   * A DELETED event at `path`: the receipt path to delete, if this watch's receipt for it is now
   * settled. `itemsPresent`: the `/to/<node>/` items still there (path to `sent_at`), so a newer
   * send already at that path keeps the receipt it is owed.
   */
  fun afterDelete(node: String, path: String, receipt: TakenReceipt?, itemsPresent: Map<String, String?>): String? {
    if (DataPaths.addressed(path, node) == null || receipt == null) return null
    return if (TakenReceipt.settled(receipt, itemsPresent)) DataPaths.taken(node, path) else null
  }

  /** The `pair` first (a book that follows it is for that account), then the books, oldest send first. */
  fun ordered(node: String, items: List<InboxItem>): List<InboxItem> =
    items.sortedWith(
      compareBy<InboxItem> { if (DataPaths.addressed(it.path, node) == DataPaths.Item.Pair) 0 else 1 }
        .thenBy { it.sentAt?.let(ISOTime::parse) ?: java.time.Instant.MIN }
        .thenBy { it.path }
    )
}
