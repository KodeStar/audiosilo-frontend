package expo.modules.audiosilowatch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The vectors match wear-core's AddressAndMessageTest (DataPaths, BookKey, TakenReceipt), the
// watch's end of the same contract.
class WearPathsTest {
  @Test
  fun itemPathsAreTheWatchs() {
    assertEquals("/audiosilo/v1/to/abc/pair", WearPaths.pair("abc"))
    assertEquals("/audiosilo/v1/to/abc/book/k1", WearPaths.book("abc", "k1"))
    assertEquals("/audiosilo/v1/from/abc/", WearPaths.from("abc"))
    assertEquals("/audiosilo/v1/watch-state", WearPaths.WATCH_STATE)
    assertEquals("audiosilo_wear_app", WearPaths.WEAR_CAPABILITY)
  }

  @Test
  fun knowsWhoAnItemIsFor() {
    assertTrue(WearPaths.isAddressedTo("/audiosilo/v1/to/abc/pair", "abc"))
    assertTrue(WearPaths.isAddressedTo("/audiosilo/v1/to/abc/book/k1", "abc"))
    assertFalse(WearPaths.isAddressedTo("/audiosilo/v1/to/abc/book/k1", "xyz"))
    assertFalse(WearPaths.isAddressedTo("/audiosilo/v1/to/abc/book/", "abc"))
    assertFalse(WearPaths.isAddressedTo("/audiosilo/v1/to/abc/book/k1/more", "abc"))
    assertFalse(WearPaths.isAddressedTo("/audiosilo/v1/to/abc/other", "abc"))
    assertEquals("abc", WearPaths.addressee("/audiosilo/v1/to/abc/pair"))
    assertNull(WearPaths.addressee("/audiosilo/v1/watch-state"))
    assertNull(WearPaths.addressee("/audiosilo/v1/to/abc/other"))
  }

  @Test
  fun knowsAReceipt() {
    assertTrue(WearPaths.isTaken("/audiosilo/v1/from/w1/taken/pair", "w1"))
    assertFalse(WearPaths.isTaken("/audiosilo/v1/from/w1/taken/pair", "w2"))
    assertFalse(WearPaths.isTaken("/audiosilo/v1/from/w1/taken/", "w1"))
    assertFalse(WearPaths.isTaken("/audiosilo/v1/from/w1/taken/a/b", "w1"))
  }
}

class BookKeyTest {
  @Test
  fun isTheHashOfAccountLibraryAndPath() {
    // printf 'srv.1|2|Author/Book' | shasum -a 256 (wear-core's vector)
    assertEquals(
      "eefecdf9736cd98fc6c4df24bf370c08787853e20d463c2599ce669a54bf4eaa",
      BookKey.of("srv", 1, 2, "Author/Book"),
    )
    assertFalse(BookKey.of("srv", 1, 2, "A/B") == BookKey.of("srv", 1, 2, "A/C"))
    assertFalse(BookKey.of("srv", 1, 2, "A/B") == BookKey.of("srv", 2, 2, "A/B"))
  }

  @Test
  fun namesABookAndItsRemoveTheSame() {
    val book = message("book", "path" to "Author/Book", "title" to "Book")
    val remove = message("remove", "path" to "Author/Book")
    val expected = "/audiosilo/v1/to/w1/book/eefecdf9736cd98fc6c4df24bf370c08787853e20d463c2599ce669a54bf4eaa"
    assertEquals(expected, pathFor(book, "w1"))
    assertEquals(expected, pathFor(remove, "w1"))
  }
}

/** Where a message for watch `node` goes, as WearLink puts it. */
private fun pathFor(message: Map<String, Any?>, node: String): String? =
  WearRules.slot(message)?.let { WearPaths.to(node) + it }

/** A message as the JS bridge gives it: every number a Double. */
private fun message(type: String, vararg extra: Pair<String, Any?>): Map<String, Any?> =
  mapOf(
    "v" to 1.0,
    "type" to type,
    "server_id" to "srv",
    "user_id" to 1.0,
    "library_id" to 2.0,
    "sent_at" to "2026-11-12T10:00:00.000Z",
  ) + extra

class PathForTest {
  @Test
  fun putsThePairAtItsOnePath() {
    assertEquals("/audiosilo/v1/to/w1/pair", pathFor(message("pair", "pairing_token" to "t"), "w1"))
  }

  @Test
  fun refusesWhatTheWatchWouldNotTake() {
    val book = message("book", "path" to "A/B")
    assertNull(pathFor(book + ("v" to 2.0), "w1"))
    assertNull(pathFor(book - "sent_at", "w1"))
    assertNull(pathFor(book + ("sent_at" to ""), "w1"))
    assertNull(pathFor(book - "path", "w1"))
    assertNull(pathFor(book + ("user_id" to 1.5), "w1"))
    assertNull(pathFor(book + ("server_id" to ""), "w1"))
    assertNull(pathFor(book + ("type" to "watch-state"), "w1"))
  }
}

class TargetAndSnapshotTest {
  private val state = mapOf<String, Any?>("v" to 1L, "type" to "watch-state", "signed_in" to true, "books" to emptyList<Any>())

  private fun view(
    connected: List<WatchNode> = emptyList(),
    capable: Set<String> = emptySet(),
    states: Map<String, Map<String, Any?>> = emptyMap(),
    seen: Map<String, Long> = emptyMap(),
    own: List<Item> = emptyList(),
  ) = LinkView(true, connected, capable, states, seen, own)

  @Test
  fun noAppOnAnyWatchIsNoTarget() {
    assertNull(WearRules.target(view(connected = listOf(WatchNode("w1", true)))))
  }

  @Test
  fun takesTheWatchThatSpokeLast() {
    val v = view(
      connected = listOf(WatchNode("w1", true), WatchNode("w2", true)),
      capable = setOf("w1", "w2"),
      states = mapOf("w1" to state, "w2" to state),
      seen = mapOf("w1" to 100L, "w2" to 200L),
    )
    assertEquals("w2", WearRules.target(v))
  }

  @Test
  fun elseTheOneNearbyThenAConnectedOneThenAny() {
    val capable = setOf("a", "b", "c")
    assertEquals("b", WearRules.target(view(connected = listOf(WatchNode("a", false), WatchNode("b", true)), capable = capable)))
    assertEquals("a", WearRules.target(view(connected = listOf(WatchNode("c", false), WatchNode("a", false)), capable = capable)))
    assertEquals("a", WearRules.target(view(capable = capable)))
    // A watch-state counts as the app being there, as the capability does.
    assertEquals("z", WearRules.target(view(states = mapOf("z" to state))))
  }

  @Test
  fun ignoresAWatchSeenOnceThatHasNoAppNow() {
    val v = view(connected = listOf(WatchNode("w1", true)), capable = setOf("w1"), seen = mapOf("gone" to 999L))
    assertEquals("w1", WearRules.target(v))
  }

  @Test
  fun aPhoneWithNoDataLayerHasNoWatch() {
    val snap = WearRules.snapshot(LinkView.NONE)
    assertEquals(false, snap["paired"])
    assertEquals(false, snap["installed"])
    assertEquals(emptyList<Any>(), snap["outstanding"])
    assertFalse(snap.containsKey("watch_id"))
  }

  @Test
  fun pairedWithoutTheAppIsNotInstalled() {
    val snap = WearRules.snapshot(view(connected = listOf(WatchNode("w1", true))))
    assertEquals(true, snap["paired"])
    assertEquals(false, snap["installed"])
    assertFalse(snap.containsKey("watch_id"))
    assertFalse(snap.containsKey("state"))
  }

  @Test
  fun aWatchOutOfReachWithAStateIsStillPairedAndInstalled() {
    val snap = WearRules.snapshot(view(states = mapOf("w1" to state)))
    assertEquals(true, snap["paired"])
    assertEquals(true, snap["installed"])
    assertEquals("w1", snap["watch_id"])
    assertEquals(state, snap["state"])
  }

  @Test
  fun listsTheTargetsBooksAndRemovesNotTakenYetNeverThePair() {
    val book = message("book", "path" to "A/B", "title" to "B")
    val remove = message("remove", "path" to "A/C")
    val own = listOf(
      Item("/audiosilo/v1/to/w1/pair", message("pair", "pairing_token" to "secret")),
      Item(pathFor(book, "w1")!!, book),
      Item(pathFor(remove, "w1")!!, remove),
      Item(pathFor(book, "other")!!, book),
      Item("/audiosilo/v1/to/w1/book/bad", mapOf("type" to "book")),
      Item("/audiosilo/v1/to/w1/book/null", null),
    )
    val snap = WearRules.snapshot(view(connected = listOf(WatchNode("w1", true)), capable = setOf("w1"), own = own))
    assertEquals(
      listOf(
        mapOf("type" to "book", "server_id" to "srv", "user_id" to 1L, "library_id" to 2L, "path" to "A/B"),
        mapOf("type" to "remove", "server_id" to "srv", "user_id" to 1L, "library_id" to 2L, "path" to "A/C"),
      ),
      snap["outstanding"],
    )
    // Nothing is ever `failed`: a Data Layer item waits for the watch.
    @Suppress("UNCHECKED_CAST")
    assertTrue((snap["outstanding"] as List<Map<String, Any?>>).none { it.containsKey("failed") })
  }
}

class ReceiptTest {
  private val book = message("book", "path" to "A/B")
  private val bookPath = pathFor(book, "w1")!!
  private val key = bookPath.substringAfterLast('/')
  private val receiptPath = "/audiosilo/v1/from/w1/taken/$key"

  private fun receipt(path: String = bookPath, sentAt: Any? = "2026-11-12T10:00:00.000Z") =
    WearRules.receipt(mapOf("v" to 1L, "type" to "taken", "path" to path, "sent_at" to sentAt))!!

  @Test
  fun readsTheWatchsReceiptOnly() {
    assertEquals(Receipt(bookPath, "2026-11-12T10:00:00.000Z"), receipt())
    assertNull(WearRules.receipt(mapOf("v" to 2L, "type" to "taken", "path" to bookPath)))
    assertNull(WearRules.receipt(mapOf("v" to 1L, "type" to "watch-state", "path" to bookPath)))
    assertNull(WearRules.receipt(mapOf("v" to 1L, "type" to "taken", "path" to "")))
    assertNull(WearRules.receipt(null))
  }

  @Test
  fun deletesTheItemItsSendNames() {
    assertEquals(bookPath, WearRules.deletable(receiptPath, "w1", receipt(), Item(bookPath, book)))
  }

  @Test
  fun keepsANewerSendAtThatPath() {
    val newer = book + ("sent_at" to "2026-11-12T10:00:05.000Z")
    assertNull(WearRules.deletable(receiptPath, "w1", receipt(), Item(bookPath, newer)))
  }

  @Test
  fun nothingToDeleteWhenTheItemIsGone() {
    assertNull(WearRules.deletable(receiptPath, "w1", receipt(), null))
  }

  @Test
  fun aWatchCanOnlyClearItsOwnItems() {
    // w2's receipt naming w1's item, or put under another watch's folder.
    assertNull(WearRules.deletable("/audiosilo/v1/from/w2/taken/$key", "w2", receipt(), Item(bookPath, book)))
    assertNull(WearRules.deletable(receiptPath, "w2", receipt(), Item(bookPath, book)))
    // The receipt's own name must be the item's last segment.
    assertNull(WearRules.deletable("/audiosilo/v1/from/w1/taken/pair", "w1", receipt(), Item(bookPath, book)))
  }

  @Test
  fun matchesThePairBySentAtToo() {
    val pair = message("pair", "pairing_token" to "t", "expires_at" to "2026-11-12T10:10:00.000Z")
    val pairPath = "/audiosilo/v1/to/w1/pair"
    val taken = "/audiosilo/v1/from/w1/taken/pair"
    assertEquals(pairPath, WearRules.deletable(taken, "w1", receipt(pairPath), Item(pairPath, pair)))
    assertNull(WearRules.deletable(taken, "w1", receipt(pairPath, "2026-11-12T09:00:00.000Z"), Item(pairPath, pair)))
  }

  @Test
  fun comparesSentAtAsTheTextTheWatchEchoes() {
    assertEquals("2026-11-12T10:00:00.000Z", WearRules.sentAtText("2026-11-12T10:00:00.000Z"))
    assertEquals("1700000000", WearRules.sentAtText(1.7E9))
    assertNull(WearRules.sentAtText(null))
  }
}

class StalePairsTest {
  private val now = WearRules.epochMs("2026-11-12T10:00:00.000Z")!!

  private fun pair(node: String, expires: String?) =
    Item(WearPaths.pair(node), message("pair") + if (expires != null) mapOf("expires_at" to expires) else emptyMap())

  @Test
  fun dropsAPairPastItsTimeOrWithNoneReadable() {
    val own = listOf(
      pair("w1", "2026-11-12T09:59:59.999Z"),
      pair("w2", "2026-11-12T10:05:00.000Z"),
      pair("w3", null),
      pair("w4", "soon"),
      pair("w5", "2026-11-12T10:00:00.000Z"),
      Item(WearPaths.book("w1", "k"), message("book", "path" to "A/B")),
    )
    assertEquals(
      listOf(WearPaths.pair("w1"), WearPaths.pair("w3"), WearPaths.pair("w4"), WearPaths.pair("w5")),
      WearRules.stalePairs(own, now),
    )
  }

  @Test
  fun aNewPairTakesThePlaceOfThoseForOtherWatches() {
    val own = listOf(pair("w1", "2026-11-12T10:05:00.000Z"), pair("w2", "2026-11-12T10:05:00.000Z"))
    assertEquals(listOf(WearPaths.pair("w2")), WearRules.stalePairs(own, now, sendingTo = "w1"))
  }

  @Test
  fun readsTheTimesJavaScriptWrites() {
    assertEquals(1762941600000L, WearRules.epochMs("2025-11-12T10:00:00.000Z"))
    assertEquals(1762941600000L, WearRules.epochMs("2025-11-12T10:00:00Z"))
    assertEquals(1762941600000L, WearRules.epochMs("2025-11-12T11:00:00+01:00"))
    assertNull(WearRules.epochMs("2025-11-12"))
  }
}

class JsonTest {
  @Test
  fun writesWholeNumbersAsIntegersAndEscapesText() {
    val text = Json.encode(
      linkedMapOf(
        "v" to 1.0,
        "user_id" to 7.0,
        "ratio" to 1.5,
        "title" to "He said \"hi\"\n\u0001",
        "addresses" to emptyMap<String, Any?>(),
        "list" to listOf(1, true, null),
      )
    )
    assertEquals(
      "{\"v\":1,\"user_id\":7,\"ratio\":1.5,\"title\":\"He said \\\"hi\\\"\\n\\u0001\",\"addresses\":{},\"list\":[1,true,null]}",
      text,
    )
  }

  @Test
  fun readsBackWhatItWritesAndWhatTheWatchWrites() {
    val m = linkedMapOf<String, Any?>("v" to 1.0, "title" to "Brontë 📚 \"q\"", "n" to listOf(1.0, 2.5))
    assertEquals(
      mapOf("v" to 1L, "title" to "Brontë 📚 \"q\"", "n" to listOf(1L, 2.5)),
      Json.decodeObject(Json.encode(m).toByteArray(Charsets.UTF_8)),
    )
    val watch = """{"v":1,"type":"watch-state","signed_in":false,"app_version":"2.7.0","unsent_events":0,"couldnt_sync":0,"books":[{"library_id":2,"path":"A\/B","title":"é","state":"ready","bytes":123456789012}]}"""
    val decoded = Json.decodeObject(watch.toByteArray(Charsets.UTF_8))!!
    assertEquals(false, decoded["signed_in"])
    @Suppress("UNCHECKED_CAST")
    val book = (decoded["books"] as List<Map<String, Any?>>)[0]
    assertEquals("A/B", book["path"])
    assertEquals("é", book["title"])
    assertEquals(123456789012L, book["bytes"])
  }

  @Test
  fun readsNoObjectFromAnythingElse() {
    assertNull(Json.decodeObject(null))
    assertNull(Json.decodeObject("[1]".toByteArray()))
    assertNull(Json.decodeObject("{\"a\":".toByteArray()))
    assertNull(Json.decodeObject("{\"a\":1} x".toByteArray()))
    assertNull(Json.decodeObject("nope".toByteArray()))
  }
}
