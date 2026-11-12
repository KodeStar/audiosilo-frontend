// Ported from watch-core/Tests/WatchCoreTests/AddressAndMessageTests.swift: address picking
// (server-address.test.ts, url-host.test.ts and connect-model.test.ts's pairingFallback), the
// rendition state machine, the phone-watch messages, the client header and the wire shapes. Not
// ported: `unattended` and `keepsTransfer` (the Apple Watch's background URLSession sends with no
// probe first; every Wear request is made by the app after the pick, decision 9) and
// `BackgroundWake` (a URLSession wake). Wear's own: the Data Layer paths, the book key, `sent_at`
// and the remove ordering, the worker's poll rules.
package app.audiosilo.wear.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** A probe that records every address it was asked (it is given only a URL) and answers from `ids`. */
class ProbeLog(private val ids: Map<String, String> = emptyMap()) {
  val asked = ArrayList<String>()
  val probe: ServerIdProbe = { url ->
    asked += url
    ids[url]
  }
}

class URLEndpointTest {
  @Test
  fun readsSchemeHostAndPortWithTheSchemesDefault() {
    assertEquals(
      URLEndpoint("https", "books.example.com", "8443"),
      URLEndpoint.parse("HTTPS://Books.Example.com:8443/api"),
    )
    assertEquals(URLEndpoint("https", "books.example.com", "443"), URLEndpoint.parse("https://books.example.com"))
    assertEquals(URLEndpoint("http", "192.168.0.5", "80"), URLEndpoint.parse("http://192.168.0.5"))
    assertEquals("::1", URLEndpoint.parse("http://[::1]:80")?.host)
    assertEquals("books.example.com", URLEndpoint.parse("https://user@books.example.com")?.host)
    assertNull(URLEndpoint.parse("nope"))
    assertNull(URLEndpoint.parse("http://host:x"))
  }
}

class AddressPickerTest {
  private val addrs = ServerAddresses("http://192.168.0.5:8080", "https://books.example.com")

  @Test
  fun homeOnlyOnThisServersId() {
    assertEquals(addrs.home, AddressPicker.choose("https://paired", addrs, "srv", "srv"))
    assertEquals(addrs.away, AddressPicker.choose("https://paired", addrs, "srv", "other"))
    assertEquals(addrs.away, AddressPicker.choose("https://paired", addrs, "srv", null))
    assertEquals("https://paired", AddressPicker.choose("https://paired", ServerAddresses("http://h"), "srv", null))
    assertEquals("https://paired", AddressPicker.choose("https://paired", null, "srv", "srv"))
  }

  // No pick yet (a launch, before the probe): the token does not go home unproven while another
  // address is known.
  @Test
  fun withNoPickHomeIsNotUsedWhileAnotherIsKnown() {
    val lan = "http://192.168.1.10:8080"
    val away = "https://books.example"
    assertEquals(away, AddressPicker.unproven(lan, ServerAddresses(lan, away)))
    assertEquals(away, AddressPicker.unproven(away, ServerAddresses(lan, null)))
    // Nothing else is known: the phone's rule, the paired URL.
    assertEquals(lan, AddressPicker.unproven(lan, ServerAddresses(lan, null)))
    assertEquals(away, AddressPicker.unproven(away, null))
  }

  @Test
  fun pickProbesHomeWithNoTokenOnlyWhenThereIsOne() = runBlocking {
    val log = ProbeLog(mapOf("http://192.168.0.5:8080" to "srv"))
    assertEquals(addrs.home, AddressPicker.pick("https://paired", addrs, "srv", log.probe))
    assertEquals(listOf("http://192.168.0.5:8080"), log.asked)
    val none = ProbeLog()
    AddressPicker.pick("https://paired", ServerAddresses(away = "https://a"), "srv", none.probe)
    assertEquals(emptyList<String>(), none.asked)
  }

  @Test
  fun ownAddresses() {
    assertTrue(AddressPicker.isOwn("http://192.168.0.5:8080/", "https://paired", addrs))
    assertTrue(AddressPicker.isOwn("https://paired", "https://paired/", null))
    assertFalse(AddressPicker.isOwn("http://evil", "https://paired", addrs))
  }

  // mergeAddresses (src/lib/server-address.test.ts).
  @Test
  fun mergeKeepsWhatItKnewWhenNothingWasSaid() {
    assertEquals(ServerAddresses(addrs.home), AddressPicker.merge(ServerAddresses(addrs.home), null))
    assertNull(AddressPicker.merge(null, null))
  }

  @Test
  fun mergeTakesANewHomeAndAway() {
    assertEquals(addrs, AddressPicker.merge(ServerAddresses("http://10.0.0.2"), addrs))
  }

  @Test
  fun mergeKeepsTheKnownHomeWhenTheAnswerLacksOne() {
    // An exchange read through the away address (or a reverse proxy): the server cannot derive home.
    assertEquals(addrs, AddressPicker.merge(addrs, ServerAddresses(away = addrs.away)))
  }

  @Test
  fun mergeDropsAnAwayAddressTheServerNoLongerHas() {
    assertEquals(ServerAddresses(addrs.home), AddressPicker.merge(addrs, ServerAddresses()))
    assertNull(AddressPicker.merge(ServerAddresses(away = addrs.away), ServerAddresses()))
  }

  @Test
  fun mergeDropsAKeptHomeThatBecameTheAwayAddress() {
    assertEquals(
      ServerAddresses(away = addrs.away),
      AddressPicker.merge(ServerAddresses(addrs.away), ServerAddresses(away = addrs.away)),
    )
    assertEquals(
      ServerAddresses(away = addrs.away),
      AddressPicker.merge(null, ServerAddresses("https://books.example.com/", addrs.away)),
    )
  }

  @Test
  fun mergeTreatsAnEmptyAddressAsAbsent() {
    assertEquals(ServerAddresses(away = addrs.away), AddressPicker.merge(addrs, ServerAddresses("", addrs.away)))
    assertNull(AddressPicker.merge(null, ServerAddresses("", "")))
  }

  // pairingFallback's rule.
  private val base = "https://192.168.0.5:8443"
  private val home = "http://192.168.0.5:8443"

  @Test
  fun fallbackToHomeHttpOnTheSameHostAndPortWhenTheProbeMatches() = runBlocking {
    val log = ProbeLog(mapOf(home to "srv"))
    assertEquals(home, AddressPicker.pairingFallback(base, home, "srv", false, log.probe))
  }

  @Test
  fun noFallbackOnATimeoutAnotherHostOrPortAnHttpsHomeOrAnotherServer() = runBlocking {
    val log = ProbeLog(mapOf(home to "srv", "http://192.168.0.6:8443" to "srv", "http://192.168.0.5:80" to "srv"))
    val p = log.probe
    assertNull(AddressPicker.pairingFallback(base, home, "srv", true, p))
    assertNull(AddressPicker.pairingFallback(base, "http://192.168.0.6:8443", "srv", false, p))
    assertNull(AddressPicker.pairingFallback(base, "http://192.168.0.5:80", "srv", false, p))
    assertNull(AddressPicker.pairingFallback("http://192.168.0.5:8443", home, "srv", false, p))
    assertNull(AddressPicker.pairingFallback(base, home, null, false, p))
    assertEquals("never asked: nothing qualified", emptyList<String>(), log.asked)
    val wrong = ProbeLog(mapOf(home to "someone-else"))
    assertNull(AddressPicker.pairingFallback(base, home, "srv", false, wrong.probe))
  }

  private class TLSFailure : Exception()

  private class Timeout : Exception()

  @Test
  fun exchangeTriesBaseThenAwayThenHomeAndNeverSendsTheTokenHomeBeforeTheProbe() = runBlocking {
    val tried = ArrayList<String>()
    val log = ProbeLog(mapOf(home to "srv"))
    val result =
      AddressPicker.exchange(
        base,
        ServerAddresses(home, "https://books.example.com"),
        "srv",
        attempt = { url ->
          tried += url
          if (url == home) {
            assertEquals("home was probed (tokenless) before the token went there", listOf(home), log.asked)
            "session"
          } else {
            throw TLSFailure()
          }
        },
        isTimeout = { it is Timeout },
        probe = log.probe,
      )
    assertEquals(listOf(base, "https://books.example.com", home), tried)
    assertEquals(home, result.base)
  }

  @Test
  fun exchangeStopsAtAServersOwnAnswer() = runBlocking {
    val tried = ArrayList<String>()
    val log = ProbeLog(mapOf(home to "srv"))
    try {
      AddressPicker.exchange<String>(
        base,
        ServerAddresses(home, "https://away"),
        "srv",
        attempt = { url ->
          tried += url
          throw APIError(401, message = "invalid pairing token")
        },
        isTimeout = { false },
        probe = log.probe,
      )
      fail("should throw")
    } catch (e: APIError) {
      assertEquals(401, e.status)
    }
    assertEquals(listOf(base), tried)
    assertEquals(emptyList<String>(), log.asked)
  }

  @Test
  fun exchangeAfterATimeoutNeverTriesHome() = runBlocking {
    val tried = ArrayList<String>()
    val log = ProbeLog(mapOf(home to "srv"))
    try {
      AddressPicker.exchange<String>(
        base,
        ServerAddresses(home),
        "srv",
        attempt = { url ->
          tried += url
          throw Timeout()
        },
        isTimeout = { it is Timeout },
        probe = log.probe,
      )
      fail("should throw")
    } catch (e: Timeout) {
      // the base's own error is reported
    }
    assertEquals(listOf(base), tried)
  }
}

class RenditionPlanTest {
  private fun f(path: String, state: String, bytes: Long? = null, retry: Double? = null) =
    RenditionFile(path, state, bytes, retry)

  @Test
  fun allReadyIsDone() {
    val s = RenditionPlan.step(RenditionsAnswer("watch", listOf(f("a", "ready", 10), f("b", "ready", 20))))
    assertEquals(RenditionPlan.Action.Done, s.action)
    assertEquals(listOf("a", "b"), s.ready.map { it.path })
  }

  @Test
  fun pendingPollsAndHandsOverTheReadyOnes() {
    val s = RenditionPlan.step(RenditionsAnswer("watch", listOf(f("a", "ready", 10), f("b", "pending"))))
    assertEquals(RenditionPlan.Action.Poll(RenditionPlan.DEFAULT_POLL), s.action)
    assertEquals(listOf("a"), s.ready.map { it.path })
  }

  @Test
  fun missingPreparesAgain() {
    assertEquals(
      RenditionPlan.Action.PrepareAgain(RenditionPlan.DEFAULT_POLL),
      RenditionPlan.step(RenditionsAnswer("watch", listOf(f("a", "missing"), f("b", "pending")))).action,
    )
  }

  @Test
  fun aFailedFileFailsWithItsRetryAfter() {
    val s =
      RenditionPlan.step(
        RenditionsAnswer("watch", listOf(f("a", "ready"), f("b", "failed", retry = 3600.0), f("c", "failed")))
      )
    assertEquals(RenditionPlan.Action.Failed(3600.0), s.action)
  }

  @Test
  fun refusals() {
    assertEquals(
      RenditionPlan.Refusal.Retry(15.0),
      RenditionPlan.refusal(APIError(503, "rendition_pending", retryAfter = 15.0)),
    )
    assertEquals(
      RenditionPlan.Refusal.Retry(60.0),
      RenditionPlan.refusal(APIError(503, "rendition_error", retryAfter = 60.0)),
    )
    assertEquals(
      RenditionPlan.Refusal.Retry(RenditionPlan.MIN_POLL),
      RenditionPlan.refusal(APIError(503, "rendition_pending", retryAfter = 0.0)),
    )
    assertEquals(
      RenditionPlan.Refusal.Failed(1200.0),
      RenditionPlan.refusal(APIError(422, "rendition_failed", retryAfter = 1200.0)),
    )
    assertEquals(RenditionPlan.Refusal.Unavailable, RenditionPlan.refusal(APIError(404, "rendition_unavailable")))
    assertEquals(RenditionPlan.Refusal.Unavailable, RenditionPlan.refusal(APIError(400, "bad_rendition")))
    assertEquals(RenditionPlan.Refusal.Gone, RenditionPlan.refusal(APIError(404)))
    assertEquals(RenditionPlan.Refusal.SignedOut, RenditionPlan.refusal(APIError(401)))
  }

  @Test
  fun aRefusalReadsFromItsBodyAndRetryAfter() {
    val e = APIError.of(503, """{"error":"not yet","code":"rendition_pending"}""", "15")
    assertEquals(APIError(503, "rendition_pending", "not yet", 15.0), e)
    assertEquals(APIError(500), APIError.of(500, "<html>", "soon"))
    assertNull(RenditionPlan.message(RenditionPlan.Refusal.Retry(5.0)))
    assertEquals(
      "This server can't make books for the watch now.",
      RenditionPlan.message(RenditionPlan.Refusal.Unavailable),
    )
    assertEquals(
      "Signed out. Set up the watch again from your phone.",
      RenditionPlan.message(RenditionPlan.Refusal.SignedOut),
    )
  }

  @Test
  fun anAnswerMustHoldEveryFileTheTimelinePlays() {
    fun files(vararg paths: String) = RenditionsAnswer("watch", paths.map { RenditionFile(it, "ready") })
    assertTrue(RenditionPlan.covers(files("a", "b"), listOf("a", "b")))
    assertTrue(RenditionPlan.covers(files("b", "a", "extra"), listOf("a", "b")))
    assertFalse(RenditionPlan.covers(files(), listOf("a")))
    assertFalse(RenditionPlan.covers(files("a"), listOf("a", "b")))
    assertFalse(RenditionPlan.covers(files("other"), listOf("a")))
    assertFalse(RenditionPlan.covers(files("a"), emptyList()))
  }

  @Test
  fun onlyARealRefusalMeansNoChapters() {
    assertTrue(RenditionPlan.meansNoChapters(APIError(404)))
    assertTrue(RenditionPlan.meansNoChapters(APIError(403)))
    assertTrue(RenditionPlan.meansNoChapters(APIError(400)))
    assertFalse(RenditionPlan.meansNoChapters(APIError(503)))
    assertFalse(RenditionPlan.meansNoChapters(APIError(500)))
    assertFalse(RenditionPlan.meansNoChapters(APIError(429)))
    assertFalse(RenditionPlan.meansNoChapters(APIError(408)))
    assertFalse(RenditionPlan.meansNoChapters(APIError(401)))
  }

  @Test
  fun aDownloadSucceedsOnlyOn200Or206() {
    assertTrue(RenditionPlan.downloadSucceeded(200))
    assertTrue(RenditionPlan.downloadSucceeded(206))
    assertFalse(RenditionPlan.downloadSucceeded(503))
    assertFalse(RenditionPlan.downloadSucceeded(422))
  }

  @Test
  fun storageNeedsTheBytesPlusHeadroom() {
    val files = listOf(f("a", "ready", 50_000_000), f("b", "pending"))
    val needed = RenditionPlan.neededBytes(files, mapOf("b" to 3600.0))
    assertEquals(50_000_000L + 22_000_000L, needed)
    assertTrue(RenditionPlan.fits(needed, needed + RenditionPlan.HEADROOM_BYTES))
    assertFalse(RenditionPlan.fits(needed, needed + RenditionPlan.HEADROOM_BYTES - 1))
  }

  // Wear (decision 8): the background worker waits the server's retry_after_seconds, 15 s at least,
  // for 30 minutes per run.
  @Test
  fun theWorkerWaitsTheServersRetryAfterAtLeastFifteenSeconds() {
    val pending = RenditionsAnswer("watch", listOf(f("a", "ready"), f("b", "pending", retry = 40.0), f("c", "pending")))
    assertEquals(40.0, RenditionPlan.workerDelay(RenditionPlan.DEFAULT_POLL, pending), 0.0)
    assertEquals(15.0, RenditionPlan.workerDelay(RenditionPlan.DEFAULT_POLL, RenditionsAnswer("watch", listOf(f("b", "pending")))), 0.0)
    assertEquals(15.0, RenditionPlan.workerDelay(RenditionPlan.DEFAULT_POLL), 0.0)
    // A 503's Retry-After, through the refusal.
    val retry = RenditionPlan.refusal(APIError(503, "rendition_pending", retryAfter = 90.0)) as RenditionPlan.Refusal.Retry
    assertEquals(90.0, RenditionPlan.workerDelay(retry.after), 0.0)
    val soon = RenditionPlan.refusal(APIError(503, "rendition_pending", retryAfter = 3.0)) as RenditionPlan.Refusal.Retry
    assertEquals(15.0, RenditionPlan.workerDelay(soon.after), 0.0)
  }

  @Test
  fun aWorkerRunStopsWaitingAfterThirtyMinutes() {
    val t0 = iso("2026-11-12T10:00:00Z")
    assertFalse(RenditionPlan.preparedTooLong(t0, t0.addingSeconds(29.0 * 60 + 59)))
    assertTrue(RenditionPlan.preparedTooLong(t0, t0.addingSeconds(30.0 * 60)))
  }
}

class RetryAfterTest {
  // The phone's rule (a finite, non-negative number, else none), capped.
  @Test
  fun readsAFiniteNonNegativeNumberCapped() {
    assertEquals(7.0, APIError.retryAfterSeconds("7"))
    assertEquals(2.5, APIError.retryAfterSeconds(" 2.5 "))
    assertEquals(0.0, APIError.retryAfterSeconds("0"))
    assertEquals(APIError.MAX_RETRY_AFTER, APIError.retryAfterSeconds("99999999999"))
    for (bad in listOf("inf", "infinity", "1e400", "nan", "-5", "abc", "", "Wed, 21 Oct 2026 07:28:00 GMT")) {
      assertNull(bad, APIError.retryAfterSeconds(bad))
    }
  }

  @Test
  fun aRefusalNeverWaitsLongerThanTheCap() {
    val e = APIError.of(503, null, "1e300")
    assertEquals(APIError.MAX_RETRY_AFTER, e.retryAfter)
    val r = RenditionPlan.refusal(e) as RenditionPlan.Refusal.Retry
    assertTrue(r.after <= APIError.MAX_RETRY_AFTER)
    assertNull(APIError.of(503, null, "inf").retryAfter)
  }
}

class PhoneMessagesTest {
  private val pair = buildJsonObject {
    put("v", 1)
    put("type", "pair")
    put("server_id", "srv")
    put("server_name", "Home")
    put("user_id", 7)
    put("user_name", "chris")
    put("base_url", "https://books.example.com")
    put("server_url", "https://books.example.com")
    put(
      "addresses",
      buildJsonObject {
        put("home", "http://192.168.0.5:8080")
        put("away", "https://books.example.com")
      },
    )
    put("pairing_token", "tok")
    put("expires_at", "2026-11-04T12:10:00Z")
    put("phone_name", "Chris's Pixel")
  }

  private fun JsonObject.with(key: String, value: Any?): JsonObject =
    JsonObject(
      toMutableMap().apply {
        when (value) {
          null -> remove(key)
          is JsonObject -> put(key, value)
          is Number -> put(key, JsonPrimitive(value))
          else -> put(key, JsonPrimitive(value.toString()))
        }
      }
    )

  @Test
  fun decodesAPairMessage() {
    val p = (PhoneMessages.decode(pair) as PhoneMessage.Pair).message
    assertEquals("srv.7", p.accountId)
    assertEquals("http://192.168.0.5:8080", p.addresses.home)
    assertEquals("tok", p.pairingToken)
    assertTrue(p.expired(iso("2026-11-04T12:10:00Z")))
    assertFalse(p.expired(iso("2026-11-04T12:09:59Z")))
  }

  @Test
  fun keepsThePhonesDisambiguatedDisplayNameSeparateFromAccountIdentity() {
    for (name in listOf("Home", "Home (books.example.com)", "Home (${"a".repeat(63)}.books.example.com:8443)")) {
      val p = (PhoneMessages.decode(pair.with("server_name", name)) as PhoneMessage.Pair).message
      assertEquals(name, p.serverName)
      assertEquals("srv.7", p.accountId)
      assertEquals("https://books.example.com", p.serverUrl)
    }
  }

  private val remove = buildJsonObject {
    put("v", 1)
    put("type", "remove")
    put("server_id", "srv")
    put("user_id", 7)
    put("library_id", 3)
    put("path", "A/B")
  }

  @Test
  fun decodesARemoveMessage() {
    assertEquals(PhoneMessage.Remove(RemoveMessage("srv", 7, BookRef(3, "A/B"))), PhoneMessages.decode(remove))
    assertEquals("srv.7", (PhoneMessages.decode(remove) as PhoneMessage.Remove).message.accountId)
    assertNull(PhoneMessages.decode(remove.with("v", 2)))
    for (key in listOf("server_id", "user_id", "library_id", "path")) {
      assertNull(key, PhoneMessages.decode(remove.with(key, null)))
    }
  }

  @Test
  fun ignoresANewerVersionAnUnknownTypeAndAMalformedOne() {
    assertNull(PhoneMessages.decode(pair.with("v", 2)))
    assertNull(PhoneMessages.decode(pair.with("type", "hello")))
    for (key in listOf("server_id", "user_id", "base_url", "pairing_token", "expires_at")) {
      assertNull(key, PhoneMessages.decode(pair.with(key, null)))
    }
    assertNull(PhoneMessages.decode(pair.with("base_url", "audiosilo://pair")))
    val badHome = pair.with("addresses", buildJsonObject { put("home", "ftp://x") })
    assertNull((PhoneMessages.decode(badHome) as PhoneMessage.Pair).message.addresses.home)
  }

  private val book = buildJsonObject {
    put("v", 1)
    put("type", "book")
    put("server_id", "srv")
    put("user_id", 7)
    put("library_id", 2)
    put("path", "A/Book")
    put("title", "Book")
  }

  @Test
  fun decodesABookMessage() {
    val b = (PhoneMessages.decode(book) as PhoneMessage.Book).message
    assertEquals(BookRef(2, "A/Book"), b.ref)
    assertEquals("srv.7", b.accountId)
    assertNull(b.author)
    assertNull(b.sentAt)
    assertNull(PhoneMessages.decode(book.with("path", "")))
  }

  @Test
  fun encodesWatchState() {
    val s =
      WatchState(
        signedIn = true,
        serverId = "srv",
        userId = 7,
        appVersion = "2.6.0",
        books = listOf(WatchStateBook(BookRef(2, "A/Book"), "Book", WatchStateBook.State.DOWNLOADING, 10)),
        unsentEvents = 3,
        couldntSync = 1,
        lastSyncAt = ISOTime.parse("2026-11-04T12:00:00Z"),
      )
    val d = PhoneMessages.encode(s)
    assertEquals("watch-state", d["type"]?.jsonPrimitive?.content)
    assertEquals(1, PhoneMessages.int(d["v"]))
    assertEquals("2026-11-04T12:00:00.000Z", d["last_sync_at"]?.jsonPrimitive?.content)
    assertEquals("downloading", d["books"]!!.jsonArray[0].jsonObject["state"]?.jsonPrimitive?.content)
    val signedOut = PhoneMessages.encode(WatchState(false, appVersion = "2.6.0", books = emptyList(), unsentEvents = 0, couldntSync = 0))
    assertNull(signedOut["server_id"])
    assertFalse(signedOut.containsKey("last_sync_at"))
  }

  // Wear's own: the DataItem carries UTF-8 JSON, and `book`/`remove` carry `sent_at`.
  @Test
  fun readsADataItemsBytesAndItsSentAt() {
    val bytes = book.with("sent_at", "2026-11-12T10:00:00.250Z").toString().toByteArray(Charsets.UTF_8)
    val b = (PhoneMessages.decodeBytes(bytes) as PhoneMessage.Book).message
    assertEquals(iso("2026-11-12T10:00:00.250Z"), b.sentAt)
    val r = PhoneMessages.decodeBytes(remove.with("sent_at", "2026-11-12T10:00:01Z").toString().toByteArray()) as PhoneMessage.Remove
    assertEquals(iso("2026-11-12T10:00:01Z"), r.message.sentAt)
    assertNull(PhoneMessages.decodeBytes("not json".toByteArray()))
    assertNull(PhoneMessages.decodeBytes(null))
    // A book whose sent_at is not a time still reads, with none.
    assertNull((PhoneMessages.decodeJSON(book.with("sent_at", "soon").toString()) as PhoneMessage.Book).message.sentAt)
  }

  @Test
  fun watchStateBytesReadBackAsJSON() {
    val s = WatchState(true, "srv", 7, "2.7.0", emptyList(), 0, 0)
    val text = String(PhoneMessages.encodeBytes(s), Charsets.UTF_8)
    assertEquals(PhoneMessages.encode(s), kotlinx.serialization.json.Json.parseToJsonElement(text))
  }

  // W3c's follow-up, solved for Wear: a Remove older than the download it would remove is ignored.
  @Test
  fun aRemoveOlderThanTheDownloadItWouldRemoveIsIgnored() {
    val queued = iso("2026-11-12T10:00:05Z")
    val older = RemoveMessage("srv", 7, BookRef(2, "A/Book"), iso("2026-11-12T10:00:00Z"))
    val newer = older.copy(sentAt = iso("2026-11-12T10:00:10Z"))
    assertFalse(PhoneMessages.removeApplies(older, queued))
    assertTrue(PhoneMessages.removeApplies(newer, queued))
    assertTrue("the same instant: the latest intent wins", PhoneMessages.removeApplies(older.copy(sentAt = queued), queued))
    assertTrue("an older phone's remove", PhoneMessages.removeApplies(older.copy(sentAt = null), queued))
    assertTrue("a download with no time", PhoneMessages.removeApplies(older, null))
  }
}

class DataLayerTest {
  @Test
  fun itemsAddressedToThisNodeOnly() {
    assertEquals("/audiosilo/v1/to/abc/pair", DataPaths.pair("abc"))
    assertEquals("/audiosilo/v1/to/abc/book/k1", DataPaths.book("abc", "k1"))
    assertEquals(DataPaths.Item.Pair, DataPaths.addressed("/audiosilo/v1/to/abc/pair", "abc"))
    assertEquals(DataPaths.Item.Book("k1"), DataPaths.addressed("/audiosilo/v1/to/abc/book/k1", "abc"))
    assertNull("another node's", DataPaths.addressed("/audiosilo/v1/to/xyz/pair", "abc"))
    assertNull("a node id that only starts the same", DataPaths.addressed("/audiosilo/v1/to/abcd/pair", "abc"))
    assertNull(DataPaths.addressed("/audiosilo/v1/watch-state", "abc"))
    assertNull(DataPaths.addressed("/audiosilo/v1/to/abc/book/", "abc"))
    assertNull(DataPaths.addressed("/audiosilo/v1/to/abc/book/k1/more", "abc"))
    assertNull(DataPaths.addressed("/audiosilo/v1/to/abc/other", "abc"))
  }

  @Test
  fun theBookKeyIsTheHashOfAccountLibraryAndPath() {
    // printf 'srv.1|2|Author/Book' | shasum -a 256
    assertEquals(
      "eefecdf9736cd98fc6c4df24bf370c08787853e20d463c2599ce669a54bf4eaa",
      BookKey.of("srv.1", 2, "Author/Book"),
    )
    assertFalse(BookKey.of("srv.1", 2, "A/B") == BookKey.of("srv.1", 2, "A/C"))
    assertFalse(BookKey.of("srv.1", 2, "A/B") == BookKey.of("srv.2", 2, "A/B"))
    assertTrue(Regex("^[0-9a-f]{64}$").matches(BookKey.of("srv.1", 2, "Brontë/Jane Eyre 📚")))
  }
}

// The receipt contract (ship-notes, "Data Layer contract changes from check 5").
class TakenReceiptTest {
  private val bookPath = "/audiosilo/v1/to/watch1/book/eefecdf9736cd98fc6c4df24bf370c08787853e20d463c2599ce669a54bf4eaa"
  private val pairPath = "/audiosilo/v1/to/watch1/pair"

  private fun bytes(text: String) = text.toByteArray(Charsets.UTF_8)

  @Test
  fun theReceiptPathMirrorsTheItemsLastSegment() {
    assertEquals("/audiosilo/v1/from/watch1/taken/pair", DataPaths.taken("watch1", pairPath))
    assertEquals(
      "/audiosilo/v1/from/watch1/taken/eefecdf9736cd98fc6c4df24bf370c08787853e20d463c2599ce669a54bf4eaa",
      DataPaths.taken("watch1", bookPath),
    )
    assertTrue(DataPaths.isTaken("/audiosilo/v1/from/watch1/taken/pair", "watch1"))
    assertFalse("another watch's", DataPaths.isTaken("/audiosilo/v1/from/watch2/taken/pair", "watch1"))
    assertFalse(DataPaths.isTaken("/audiosilo/v1/from/watch1/taken/", "watch1"))
    assertFalse(DataPaths.isTaken("/audiosilo/v1/from/watch1/taken/a/b", "watch1"))
    assertFalse("the phone's items are not receipts", DataPaths.isTaken(pairPath, "watch1"))
    assertNull("a receipt is never an item addressed to the watch", DataPaths.addressed(DataPaths.taken("watch1", pairPath), "watch1"))
  }

  @Test
  fun theReceiptEchoesSentAtExactlyAsWritten() {
    val item = bytes("""{"v":1,"type":"book","server_id":"srv","user_id":1,"library_id":2,"path":"A/B","sent_at":"2026-11-12T10:00:00.250Z"}""")
    val r = TakenReceipt.of(bookPath, item)!!
    assertEquals(TakenReceipt(bookPath, "2026-11-12T10:00:00.250Z"), r)
    val json = PhoneMessages.encode(r)
    assertEquals(setOf("v", "type", "path", "sent_at"), json.keys)
    assertEquals("taken", (json["type"] as kotlinx.serialization.json.JsonPrimitive).content)
    assertEquals(r, PhoneMessages.decodeReceipt(PhoneMessages.encodeBytes(r)))
    // An offset or extra precision is kept as is: the phone compares text.
    val odd = TakenReceipt.of(bookPath, bytes("""{"v":1,"sent_at":"2026-11-12T11:00:00.123456+01:00"}"""))!!
    assertEquals("2026-11-12T11:00:00.123456+01:00", odd.sentAt)
  }

  @Test
  fun aPairWithoutSentAtGetsAReceiptWithout() {
    val r = TakenReceipt.of(pairPath, bytes("""{"v":1,"type":"pair"}"""))!!
    assertNull(r.sentAt)
    assertFalse(PhoneMessages.encode(r).containsKey("sent_at"))
    assertEquals(r, PhoneMessages.decodeReceipt(PhoneMessages.encodeBytes(r)))
  }

  @Test
  fun bytesThatAreNotAnObjectGetNoReceipt() {
    assertNull(TakenReceipt.of(bookPath, null))
    assertNull(TakenReceipt.of(bookPath, bytes("not json")))
    assertNull(TakenReceipt.of(bookPath, bytes("[1,2]")))
    assertNull(PhoneMessages.decodeReceipt(bytes("""{"v":2,"type":"taken","path":"/x"}""")))
    assertNull(PhoneMessages.decodeReceipt(bytes("""{"v":1,"type":"book","path":"/x"}""")))
    assertNull(PhoneMessages.decodeReceipt(bytes("""{"v":1,"type":"taken"}""")))
  }

  @Test
  fun aReceiptNamesOnlyTheSendItAnswers() {
    val r = TakenReceipt(bookPath, "2026-11-12T10:00:00.250Z")
    assertTrue("handled already: a start-up re-read skips it", r.names(bookPath, "2026-11-12T10:00:00.250Z"))
    assertFalse("sent again since", r.names(bookPath, "2026-11-12T10:05:00.000Z"))
    assertFalse("another book", r.names(pairPath, "2026-11-12T10:00:00.250Z"))
  }

  @Test
  fun aReceiptGoesOnceTheItemItNamesIsGone() {
    val r = TakenReceipt(bookPath, "t1")
    assertFalse("the phone has not deleted it yet", TakenReceipt.settled(r, mapOf(bookPath to "t1")))
    assertTrue("deleted", TakenReceipt.settled(r, mapOf(pairPath to "t9")))
    assertTrue("replaced by a newer send", TakenReceipt.settled(r, mapOf(bookPath to "t2")))
    assertFalse(TakenReceipt.settled(TakenReceipt(pairPath, null), mapOf(pairPath to null)))
  }
}

class ClientHeaderAndWireTest {
  @Test
  fun theIdentityHeader() {
    assertEquals("X-AudioSilo-Client", ClientHeader.NAME)
    assertEquals("audiosilo-watch/2.6.0 (wearos)", ClientHeader.value("2.6.0"))
    assertEquals("audiosilo-watch/0 (wearos)", ClientHeader.value(null))
    assertEquals("audiosilo-watch/2.6beta (wearos)", ClientHeader.value("2.6 beta!"))
  }

  private inline fun <reified T> decode(text: String, s: kotlinx.serialization.KSerializer<T>): T =
    Wire.json.decodeFromString(s, text)

  @Test
  fun theServerGate() {
    assertTrue(
      decode(
          """{"name":"S","server_id":"srv","version":"2.6.0","capabilities":{"listening_sync":true,"renditions":true},"renditions":["watch"]}""",
          ServerInfo.serializer(),
        )
        .supportsWatch
    )
    assertFalse(
      decode("""{"version":"2.5.1","capabilities":{"listening_sync":true}}""", ServerInfo.serializer()).supportsWatch
    )
    assertFalse(
      decode(
          """{"capabilities":{"listening_sync":true,"renditions":false},"renditions":[]}""",
          ServerInfo.serializer(),
        )
        .supportsWatch
    )
    assertFalse(decode("""{"capabilities":{},"renditions":["watch"]}""", ServerInfo.serializer()).supportsWatch)
    assertEquals("srv", decode("""{"server_id":"srv"}""", ServerInfo.serializer()).serverId)
  }

  @Test
  fun decodesASyncAnswerAndAProgressRowWithOtherPlace() {
    val json =
      """
      {"server_time":"2026-10-25T07:41:03.480123Z","results":[{"id":"a","status":"diverged","kept":"stored",
      "other_place":{"position":900,"device_id":"watch","device_name":"W","updated_at":"2026-10-08T11:00:00Z"}}],
      "progress":[{"library_id":3,"path":"Author/Book","position":16800,"duration":61200,"finished":false,
      "playback_speed":1.2,"version":42,"device_id":"d","updated_at":"2026-10-25T07:33:30Z","device_name":"Phone",
      "other_place":{"position":900,"device_id":"watch","device_name":"W","updated_at":"2026-10-08T11:00:00Z"}}]}
      """
    val a = decode(json, SyncResponse.serializer())
    assertEquals(900.0, a.results?.first()?.otherPlace?.position)
    assertEquals(42, a.progress?.first()?.version)
    assertEquals("watch", a.progress?.first()?.otherPlace?.deviceId)
    assertTrue(ISOTime.parse(a.serverTime!!) != null)
    val none = decode("""{"server_time":"x","results":[],"progress":null}""", SyncResponse.serializer())
    assertNull(none.progress)
  }

  @Test
  fun aFinishEventRoundTrips() {
    val e: ListeningEvent = FinishEvent("f", "unfinish", 2, "p", "2026-10-25T08:00:00.000Z", 3)
    val text = Wire.json.encodeToString(ListeningEvent.serializer(), e)
    val json = Wire.json.parseToJsonElement(text).jsonObject
    assertEquals(setOf("id", "kind", "library_id", "path", "at", "base_version"), json.keys)
    assertEquals("unfinish", json["kind"]?.jsonPrimitive?.content)
    assertEquals(e, Wire.json.decodeFromString(ListeningEvent.serializer(), text))
  }

  @Test
  fun decodesABookAndARenditionsAnswer() {
    val book =
      decode(
        """{"id":1,"library_id":2,"rel_path":"A/Book","title":"Book","author":"A","duration":160,"size":15,"files":[{"rel_path":"A/Book/01.mp3","seq":1,"duration":60,"format":"mp3","size":5}],"chapters":[{"index":0,"title":"One","file_index":0,"file_path":"A/Book/01.mp3","start":0,"end":60,"book_offset":0}]}""",
        Book.serializer(),
      )
    assertEquals("A/Book/01.mp3", book.files?.first()?.relPath)
    assertEquals("A/Book/01.mp3", book.chapters?.first()?.filePath)
    val r =
      decode(
        """{"kind":"watch","files":[{"path":"A/Book/01.mp3","state":"failed","retry_after_seconds":3600},{"path":"b","state":"ready","bytes":123}]}""",
        RenditionsAnswer.serializer(),
      )
    assertEquals(3600.0, r.files[0].retryAfterSeconds)
    assertEquals(123L, r.files[1].bytes)
  }

  @Test
  fun decodesAnExchangeAnswer() {
    val s =
      decode(
        """{"token":"t","server_id":"srv","user":{"id":7,"username":"chris","display_name":"Chris"},"addresses":{"home":"http://h"},"extra":1}""",
        AuthSession.serializer(),
      )
    assertEquals(WireUser(7, "chris", "Chris"), s.user)
    assertEquals("http://h", s.addresses?.home)
  }
}

class ContinueOrderTest {
  @Test
  fun startedAndNotFinishedNewestFirstCapped() {
    fun r(path: String, pos: Double, finished: Boolean = false, at: String) =
      ProgressRow(1, path, pos, 100.0, finished, 1.0, 1, "d", at)
    val rows =
      listOf(
        r("old", 5.0, at = "2026-10-01T00:00:00Z"),
        r("new", 5.0, at = "2026-10-03T00:00:00.5Z"),
        r("unstarted", 0.0, at = "2026-10-04T00:00:00Z"),
        r("done", 100.0, finished = true, at = "2026-10-05T00:00:00Z"),
        r("mid", 5.0, at = "2026-10-02T00:00:00Z"),
      )
    assertEquals(listOf("new", "mid", "old"), ContinueOrder.inProgress(rows, 10).map { it.path })
    assertEquals(listOf("new", "mid"), ContinueOrder.inProgress(rows, 2).map { it.path })
  }
}
