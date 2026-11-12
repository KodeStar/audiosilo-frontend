// PhoneLink's rules over the receipt contract (ship-notes, "Data Layer contract changes from
// check 5"): read everything at a start, skip what a receipt names, never act on a DELETED, drop a
// receipt once its item is gone, ignore other nodes.
package app.audiosilo.wear.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneInboxTest {
  private val me = "watch1"
  private val pairPath = DataPaths.pair(me)
  private val bookA = DataPaths.book(me, "aaaa")
  private val bookB = DataPaths.book(me, "bbbb")

  private fun item(path: String, sentAt: String?, type: String = "book"): InboxItem {
    val at = sentAt?.let { ""","sent_at":"$it"""" } ?: ""
    return InboxItem(path, """{"v":1,"type":"$type"$at}""".toByteArray(Charsets.UTF_8))
  }

  private fun receipt(forPath: String, sentAt: String?): InboxItem =
    InboxItem(DataPaths.taken(me, forPath), PhoneMessages.encodeBytes(TakenReceipt(forPath, sentAt)))

  @Test
  fun aStartHandlesEveryItemNoReceiptNames() {
    val items =
      listOf(
        item(bookB, "2026-11-12T10:00:02Z"),
        item(bookA, "2026-11-12T10:00:01Z"),
        item(pairPath, "2026-11-12T10:00:03Z", "pair"),
      )
    val sweep = PhoneInbox.sweep(me, items, emptyList())
    assertEquals("the pair first, then the books oldest first", listOf(pairPath, bookA, bookB), sweep.handle.map { it.path })
    assertTrue(sweep.dropReceipts.isEmpty())
  }

  @Test
  fun anItemItsReceiptNamesIsNotHandledAgain() {
    val items = listOf(item(bookA, "2026-11-12T10:00:01Z"), item(bookB, "2026-11-12T10:00:02Z"))
    val receipts = listOf(receipt(bookA, "2026-11-12T10:00:01Z"))
    val sweep = PhoneInbox.sweep(me, items, receipts)
    assertEquals(listOf(bookB), sweep.handle.map { it.path })
    assertTrue("its item is still there: the phone has not seen the receipt yet", sweep.dropReceipts.isEmpty())
  }

  @Test
  fun aNewerSendAtTheSamePathIsHandledAndItsOldReceiptGoes() {
    // The phone sent Remove after the Download the watch took: same path, a later sent_at.
    val items = listOf(item(bookA, "2026-11-12T11:00:00Z", "remove"))
    val receipts = listOf(receipt(bookA, "2026-11-12T10:00:01Z"))
    val sweep = PhoneInbox.sweep(me, items, receipts)
    assertEquals(listOf(bookA), sweep.handle.map { it.path })
    assertEquals(listOf(DataPaths.taken(me, bookA)), sweep.dropReceipts)
  }

  @Test
  fun aReceiptWhoseItemIsGoneIsDropped() {
    val sweep = PhoneInbox.sweep(me, emptyList(), listOf(receipt(pairPath, "2026-11-12T10:00:00Z")))
    assertTrue(sweep.handle.isEmpty())
    assertEquals(listOf(DataPaths.taken(me, pairPath)), sweep.dropReceipts)
  }

  @Test
  fun anotherWatchsItemsAndReceiptsAreNotThisOnes() {
    val other = DataPaths.book("watch2", "aaaa")
    val othersReceipt = InboxItem(DataPaths.taken("watch2", other), PhoneMessages.encodeBytes(TakenReceipt(other, "x")))
    val sweep = PhoneInbox.sweep(me, listOf(item(other, "2026-11-12T10:00:00Z")), listOf(othersReceipt))
    assertTrue(sweep.handle.isEmpty())
    assertTrue(sweep.dropReceipts.isEmpty())
    assertFalse(PhoneInbox.handles(me, item(other, "x"), null))
  }

  @Test
  fun anUnreadableReceiptNamesNothing() {
    val junk = InboxItem(DataPaths.taken(me, bookA), "nope".toByteArray())
    val sweep = PhoneInbox.sweep(me, listOf(item(bookA, "t1")), listOf(junk))
    assertEquals(listOf(bookA), sweep.handle.map { it.path })
    assertTrue(sweep.dropReceipts.isEmpty())
  }

  @Test
  fun aChangeIsHandledUnlessItsReceiptNamesIt() {
    val a = item(bookA, "t1")
    assertTrue(PhoneInbox.handles(me, a, null))
    assertFalse("the service and the running app's listener both saw it", PhoneInbox.handles(me, a, TakenReceipt(bookA, "t1")))
    assertTrue("a newer send", PhoneInbox.handles(me, item(bookA, "t2"), TakenReceipt(bookA, "t1")))
    assertTrue("a pair with no sent_at and no receipt", PhoneInbox.handles(me, item(pairPath, null, "pair"), null))
    assertFalse(PhoneInbox.handles(me, item(pairPath, null, "pair"), TakenReceipt(pairPath, null)))
    assertFalse("not an item path", PhoneInbox.handles(me, item(DataPaths.WATCH_STATE, "t1"), null))
  }

  @Test
  fun aDeleteIsNeverAnInstructionOnlyTheReceiptsEnd() {
    // The phone saw the receipt and deleted its item: the receipt goes.
    assertEquals(DataPaths.taken(me, bookA), PhoneInbox.afterDelete(me, bookA, TakenReceipt(bookA, "t1"), emptyMap()))
    // The phone app was uninstalled, its items deleted, nothing handled yet: nothing to do.
    assertNull(PhoneInbox.afterDelete(me, bookA, null, emptyMap()))
    // A newer send already sits at the path, its receipt not put yet: the old receipt names the
    // old item, which is gone, so it goes; the new item is handled by its own CHANGED.
    assertEquals(DataPaths.taken(me, bookA), PhoneInbox.afterDelete(me, bookA, TakenReceipt(bookA, "t1"), mapOf(bookA to "t2")))
    // The receipt names what is still there (the DELETED raced a re-put of the same item): kept.
    assertNull(PhoneInbox.afterDelete(me, bookA, TakenReceipt(bookA, "t2"), mapOf(bookA to "t2")))
    assertNull("another node's", PhoneInbox.afterDelete(me, DataPaths.book("watch2", "aaaa"), TakenReceipt(bookA, "t1"), emptyMap()))
  }

  @Test
  fun itemsCompareByPathAndBytes() {
    assertEquals(item(bookA, "t1"), item(bookA, "t1"))
    assertFalse(item(bookA, "t1") == item(bookA, "t2"))
    assertEquals("t1", item(bookA, "t1").sentAt)
    assertNull(InboxItem(bookA, null).sentAt)
  }
}
