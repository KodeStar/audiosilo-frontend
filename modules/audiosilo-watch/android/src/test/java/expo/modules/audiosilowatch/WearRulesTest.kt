package expo.modules.audiosilowatch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
  private val pair = message("pair", "pairing_token" to "t", "expires_at" to "2026-11-12T10:10:00.000Z")

  @Test
  fun putsThePairAtItsOnePath() {
    assertEquals("/audiosilo/v1/to/w1/pair", pathFor(pair, "w1"))
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

  // fe#286: the watch takes no blank id (PhoneMessages' `nonEmpty`), so the phone sends none.
  @Test
  fun refusesABlankIdAsTheWatchDoes() {
    val book = message("book", "path" to "A/B")
    assertNull(pathFor(book + ("server_id" to "  "), "w1"))
    assertNull(pathFor(book + ("path" to " \t"), "w1"))
    assertNull(pathFor(message("remove", "path" to "   "), "w1"))
    assertNotNull(pathFor(book + ("path" to " A/B"), "w1"))
    assertNull(pathFor(pair + ("server_id" to " "), "w1"))
    assertNull(pathFor(pair + ("pairing_token" to "\t"), "w1"))
    assertNull(pathFor(pair - "pairing_token", "w1"))
  }

  // The watch reads a user or library id to 2^53 - 1 (PhoneMessages' `id`; 32 bits until fe#285)
  // and takes no pair without a time it can read, so the phone sends neither past that: the item
  // would wait there untaken.
  @Test
  fun refusesAnIdOrAPairTheWatchCannotRead() {
    val book = message("book", "path" to "A/B")
    assertNotNull(pathFor(book + ("user_id" to 2147483648.0), "w1"))
    assertNotNull(pathFor(book + ("library_id" to 4294967296.0), "w1"))
    assertNotNull(pathFor(book + ("library_id" to 9007199254740991.0), "w1"))
    assertNotNull(pathFor(message("remove", "path" to "A/B", "library_id" to -2147483649.0), "w1"))
    assertNotNull(pathFor(pair + ("user_id" to 2147483648.0), "w1"))
    assertNull(pathFor(book + ("user_id" to 9007199254740992.0), "w1"))
    assertNull(pathFor(book + ("library_id" to 9007199254740992L), "w1"))
    assertNull(pathFor(message("remove", "path" to "A/B", "library_id" to -9007199254740992.0), "w1"))
    assertNull(pathFor(pair + ("user_id" to 9007199254740993L), "w1"))
    assertNull(pathFor(pair - "user_id", "w1"))
    assertNull(pathFor(pair - "expires_at", "w1"))
    assertNull(pathFor(pair + ("expires_at" to "soon"), "w1"))
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
    assertNull(WearRules.receipt(mapOf("v" to 1L, "type" to "taken", "path" to "  ")))
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

  // fe#286: the alarm that drops a pair with the app idle goes off at the first one's time.
  @Test
  fun theNextPruneIsTheFirstPairsTime() {
    val own = listOf(
      pair("w1", "2026-11-12T10:05:00.000Z"),
      pair("w2", "2026-11-12T10:03:00.000Z"),
      pair("w3", null),
      Item(WearPaths.book("w1", "k"), message("book", "path" to "A/B", "expires_at" to "2026-11-12T10:01:00.000Z")),
    )
    assertEquals(WearRules.epochMs("2026-11-12T10:03:00.000Z"), WearRules.nextPairExpiry(own))
    assertNull("no pair held: no alarm", WearRules.nextPairExpiry(own.drop(2)))
    assertNull(WearRules.nextPairExpiry(emptyList()))
    // What is left once the stale ones go: the alarm moves on to the next.
    val left = own.filter { it.path !in WearRules.stalePairs(own, WearRules.epochMs("2026-11-12T10:03:00.000Z")!!) }
    assertEquals(WearRules.epochMs("2026-11-12T10:05:00.000Z"), WearRules.nextPairExpiry(left))
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

// fe#285: the pair prune outlives a sweep that did not get through, and a boot.
class PruneAlarmTest {
  @Test
  fun aSweepThatDidNotGetThroughIsTriedAgainForAboutAnHour() {
    val delays = (1..WearRules.PRUNE_RETRIES).map { WearRules.pruneRetryDelayMs(it) }
    assertEquals(listOf(1L, 2L, 4L, 8L, 16L, 32L).map { it * 60_000L }, delays)
    assertNull("then the next start's sweep", WearRules.pruneRetryDelayMs(WearRules.PRUNE_RETRIES + 1))
    assertNull("the alarm at an expiry is no retry", WearRules.pruneRetryDelayMs(0))
  }

  /** What a `PruneAlarm` did to the phone, in order. */
  private class Phone(var alarms: Boolean = true) : PruneAlarm.Device {
    val did = ArrayList<String>()
    var receiverOn = false
    var alarmAt: Long? = null

    override fun alarm(at: Long?, attempt: Int): Boolean {
      if (!alarms) return false
      alarmAt = at
      did += if (at == null) "cancel" else "alarm $at try $attempt"
      return true
    }

    override fun bootReceiver(on: Boolean) {
      receiverOn = on
      did += if (on) "receiver on" else "receiver off"
    }
  }

  // The boot receiver is on exactly while an alarm is set, each pair of steps under the one lock.
  @Test
  fun theBootReceiverIsOnOnlyWhileAnAlarmIsSet() {
    val phone = Phone()
    val alarm = PruneAlarm(phone)
    // A new process applies its first answer whatever it is: an earlier one's alarm outlived it.
    alarm.arm(null)
    assertEquals(listOf("cancel", "receiver off"), phone.did)
    alarm.arm(1_000L)
    alarm.arm(1_000L)
    assertEquals(listOf("alarm 1000 try 0", "receiver on"), phone.did.drop(2))
    alarm.arm(null)
    assertEquals(listOf("cancel", "receiver off"), phone.did.drop(4))
    assertEquals(6, phone.did.size)
  }

  // The alarm went off and its sweep found no pair left: the sweep's own `arm` (under the link's
  // lock, where a send arms too) turns the receiver off, so nothing after it can undo a send's.
  @Test
  fun theSweepOfAnAlarmGoneTurnsTheReceiverOffItself() {
    val phone = Phone()
    val alarm = PruneAlarm(phone)
    alarm.arm(1_000L)
    alarm.due()
    alarm.arm(null)
    assertFalse(phone.receiverOn)
    assertNull(phone.alarmAt)
    // A send after that sweep arms its pair's alarm, and nothing is left to turn the receiver off.
    alarm.arm(5_000L)
    assertTrue(phone.receiverOn)
    assertEquals(5_000L, phone.alarmAt)
  }

  // An alarm a moment early finds its pair not stale yet: the same time is set again, not skipped.
  @Test
  fun anAlarmGoneIsSetAgainForTheSameTime() {
    val phone = Phone()
    val alarm = PruneAlarm(phone)
    alarm.arm(1_000L)
    alarm.due()
    alarm.arm(1_000L)
    assertEquals(listOf("alarm 1000 try 0", "receiver on", "alarm 1000 try 0", "receiver on"), phone.did)
    // A send that armed while the alarm's sweep waited is not set twice.
    alarm.due()
    alarm.arm(2_000L)
    alarm.arm(2_000L)
    assertEquals(6, phone.did.size)
  }

  @Test
  fun aRetryTakesTheAlarmsPlaceAndKeepsTheReceiverOn() {
    val phone = Phone()
    val alarm = PruneAlarm(phone)
    alarm.arm(1_000L)
    alarm.due()
    alarm.retry(61_000L, 1)
    assertEquals(listOf("alarm 61000 try 1", "receiver on"), phone.did.drop(2))
    // The retry's sweep got through: the pair's own time again, or none.
    alarm.due()
    alarm.arm(null)
    assertFalse(phone.receiverOn)
  }

  // No alarm service: nothing is recorded as set, so the next answer tries again.
  @Test
  fun anAlarmThatCouldNotBeSetIsTriedAtTheNextAnswer() {
    val phone = Phone(alarms = false)
    val alarm = PruneAlarm(phone)
    alarm.arm(1_000L)
    assertTrue(phone.did.isEmpty())
    phone.alarms = true
    alarm.arm(1_000L)
    assertEquals(listOf("alarm 1000 try 0", "receiver on"), phone.did)
  }

  @Test
  fun aBootOrAnUpdateSetsTheAlarmAgainAndNothingElseDoes() {
    assertTrue(PairPruneBootReceiver.handles("android.intent.action.BOOT_COMPLETED"))
    assertTrue(PairPruneBootReceiver.handles("android.intent.action.MY_PACKAGE_REPLACED"))
    assertFalse(PairPruneBootReceiver.handles("android.intent.action.LOCKED_BOOT_COMPLETED"))
    assertFalse(PairPruneBootReceiver.handles(null))
  }

  // The manifest the app merges: the boot receiver takes only the system's two broadcasts, starts
  // off (WearLink turns it on while a prune is due), and the alarm's own receiver stays private.
  @Test
  fun theManifestWiresTheBootReceiver() {
    val doc =
      javax.xml.parsers.DocumentBuilderFactory.newInstance()
        .apply { isNamespaceAware = true }
        .newDocumentBuilder()
        .parse(java.io.File("src/main/AndroidManifest.xml"))
    val ns = "http://schemas.android.com/apk/res/android"
    fun elements(tag: String) =
      doc.getElementsByTagName(tag).let { l -> (0 until l.length).map { l.item(it) as org.w3c.dom.Element } }
    assertTrue(elements("uses-permission").any { it.getAttributeNS(ns, "name") == "android.permission.RECEIVE_BOOT_COMPLETED" })
    val receivers = elements("receiver").associateBy { it.getAttributeNS(ns, "name").substringAfterLast('.') }
    val boot = receivers.getValue("PairPruneBootReceiver")
    assertEquals("false", boot.getAttributeNS(ns, "enabled"))
    assertEquals("true", boot.getAttributeNS(ns, "exported"))
    val actions = boot.getElementsByTagName("action").let { l -> (0 until l.length).map { (l.item(it) as org.w3c.dom.Element).getAttributeNS(ns, "name") } }
    assertEquals(PairPruneBootReceiver.ACTIONS, actions.toSet())
    assertEquals("false", receivers.getValue("PairPruneReceiver").getAttributeNS(ns, "exported"))
  }
}
