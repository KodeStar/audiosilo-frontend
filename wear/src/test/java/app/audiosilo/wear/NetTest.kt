// The server client against a real HTTP server (MockWebServer): the identity header and Bearer on
// every request, never `?token=`, a book path that reads back exactly, the server's refusals as
// APIError, the download's Range + If-Range, the tokenless probe; then the address router's rule
// (no token to home before the probe) and Continue listening.
package app.audiosilo.wear

import app.audiosilo.wear.core.APIError
import app.audiosilo.wear.core.Account
import app.audiosilo.wear.core.Book
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.BookServer
import app.audiosilo.wear.core.ChaptersResponse
import app.audiosilo.wear.core.Fetched
import app.audiosilo.wear.core.ProgressRow
import app.audiosilo.wear.core.RenditionsAnswer
import app.audiosilo.wear.core.ServerAddresses
import app.audiosilo.wear.core.SyncRequest
import app.audiosilo.wear.net.AddressRouter
import app.audiosilo.wear.net.ApiClient
import app.audiosilo.wear.net.ContinueListening
import app.audiosilo.wear.net.ProvenBookServer
import app.audiosilo.wear.storage.Files
import java.io.File
import java.io.IOException
import java.net.URLDecoder
import java.nio.file.Files as NioFiles
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

private fun RecordedRequest.query(name: String): String? =
  requestUrl!!.encodedQuery!!.split("&").map { it.split("=", limit = 2) }.firstOrNull { it[0] == name }?.let { URLDecoder.decode(it[1], "UTF-8") }

class ApiClientTest {
  private val server = MockWebServer()

  @Before
  fun setUp() = server.start()

  @After
  fun tearDown() = server.shutdown()

  private fun base() = server.url("/").toString()

  @Test
  fun everyRequestCarriesTheHeaderAndBearer() = runTest {
    server.enqueue(json("""{"progress":[]}"""))
    ApiClient(base(), "tok-1").allProgress()
    val r = server.takeRequest()
    assertEquals("/api/v1/me/progress", r.path)
    assertEquals("Bearer tok-1", r.getHeader("Authorization"))
    assertEquals("audiosilo-watch/${ApiClient.APP_VERSION} (wearos)", r.getHeader("X-AudioSilo-Client"))
    assertTrue(r.getHeader("X-AudioSilo-Client")!!.endsWith("(wearos)"))
    assertFalse("never ?token=", r.path!!.contains("token="))
  }

  @Test
  fun signedOutRequestsCarryNoToken() = runTest {
    server.enqueue(json("""{"server_id":"srv","version":"2.7.0","capabilities":{"listening_sync":true},"renditions":["watch"]}"""))
    val info = ApiClient(base(), null).serverInfo()
    assertEquals("srv", info.serverId)
    assertTrue(info.supportsWatch)
    assertNull(server.takeRequest().getHeader("Authorization"))
  }

  @Test
  fun aBookPathReadsBackExactly() = runTest {
    val path = "Smith; Jones/Book +1 & 2=3 %41 #?/Brontë.m4b"
    server.enqueue(json("""{"rel_path":"x","title":"T","duration":1}"""))
    ApiClient(base(), "t").item(BookRef(4, path))
    val r = server.takeRequest()
    assertEquals("/api/v1/libraries/4/item", r.requestUrl!!.encodedPath)
    assertEquals(path, r.query("path"))
    assertFalse(r.requestUrl!!.encodedQuery!!.contains(";"))
  }

  @Test
  fun refusalsAreAPIErrorsWithRetryAfter() = runTest {
    server.enqueue(json("""{"error":"still making it","code":"rendition_pending"}""", 503).setHeader("Retry-After", "12"))
    try {
      ApiClient(base(), "t").renditionStatus(BookRef(1, "A/B"))
      fail("no error")
    } catch (e: APIError) {
      assertEquals(503, e.status)
      assertEquals("rendition_pending", e.code)
      assertEquals(12.0, e.retryAfter)
    }
    val r = server.takeRequest()
    assertEquals("watch", r.query("kind"))
  }

  @Test
  fun prepareAndExchangeSendSnakeCaseJSON() = runTest {
    server.enqueue(json("""{"kind":"watch","files":[{"path":"A/B/1.mp3","state":"pending","retry_after_seconds":5}]}""", 202))
    val answer = ApiClient(base(), "t").prepareRenditions(BookRef(1, "A/B"))
    assertEquals(5.0, answer.files[0].retryAfterSeconds)
    val prep = server.takeRequest()
    assertEquals("POST", prep.method)
    assertEquals("""{"kind":"watch"}""", prep.body.readUtf8())

    server.enqueue(json("""{"token":"as_new","server_id":"srv","user":{"id":2,"username":"ann"}}"""))
    val s = ApiClient(base(), null).exchange("pt-1", "Pixel Watch")
    assertEquals("as_new", s.token)
    val ex = server.takeRequest()
    assertEquals("""{"pairing_token":"pt-1","device_name":"Pixel Watch"}""", ex.body.readUtf8())
    assertNull(ex.getHeader("Authorization"))
  }

  @Test
  fun progressOfOneBookMayBeNone() = runTest {
    server.enqueue(json("""{"progress":null}"""))
    assertNull(ApiClient(base(), "t").progress(BookRef(1, "A/B")))
    server.enqueue(json("""{"progress":{"library_id":1,"path":"A/B","position":5,"duration":10,"finished":false,"version":3,"updated_at":"2026-11-01T00:00:00Z"}}"""))
    assertEquals(3, ApiClient(base(), "t").progress(BookRef(1, "A/B"))!!.version)
  }

  @Test
  fun aDownloadResumesWithRangeAndIfRange() = runTest {
    server.enqueue(MockResponse().setResponseCode(206).setHeader("ETag", "\"e1\"").setBody(Buffer().write(ByteArray(10) { 7 })))
    val f = ApiClient(base(), "t").download(1, "A/B/1.mp3", 100, "\"e1\"")
    f.use {
      assertEquals(206, it.status)
      assertEquals("\"e1\"", it.etag)
      assertEquals(10, it.body.readBytes().size)
    }
    val r = server.takeRequest()
    assertEquals("bytes=100-", r.getHeader("Range"))
    assertEquals("\"e1\"", r.getHeader("If-Range"))
    assertEquals("watch", r.query("rendition"))
    assertEquals("1", r.query("download"))
    assertEquals("A/B/1.mp3", r.query("path"))
    assertEquals("Bearer t", r.getHeader("Authorization"))

    server.enqueue(MockResponse().setResponseCode(200).setBody("whole"))
    ApiClient(base(), "t").download(1, "A/B/1.mp3", 0, null).close()
    val whole = server.takeRequest()
    assertNull(whole.getHeader("Range"))
    assertNull(whole.getHeader("If-Range"))

    server.enqueue(json("""{"code":"rendition_pending"}""", 503))
    try {
      ApiClient(base(), "t").download(1, "A/B/1.mp3", 0, null)
      fail("no error")
    } catch (e: APIError) {
      assertEquals("rendition_pending", e.code)
    }
  }

  @Test
  fun theSyncBodyIsSnakeCase() = runTest {
    server.enqueue(json("""{"server_time":"2026-11-12T00:00:00Z","results":[]}"""))
    ApiClient(base(), "t").syncListening(SyncRequest(deviceId = "D1", sentAt = "2026-11-12T00:00:00.000Z", events = emptyList()))
    val body = server.takeRequest().body.readUtf8()
    assertTrue(body, body.contains("\"device_id\":\"D1\""))
    assertTrue(body, body.contains("\"sent_at\""))
    assertFalse("no clock_offset from Wear", body.contains("clock_offset"))
  }

  @Test
  fun theProbeAsksWithNoTokenAndNeverThrows() = runTest {
    server.enqueue(json("""{"server_id":"srv-home"}"""))
    assertEquals("srv-home", ApiClient.probeServerId(base()))
    assertNull(server.takeRequest().getHeader("Authorization"))
    server.enqueue(json("{}", 500))
    assertNull(ApiClient.probeServerId(base()))
    assertNull(ApiClient.probeServerId("http://127.0.0.1:1"))
  }

  @Test
  fun noAnswerIsAnIOException() = runTest {
    try {
      ApiClient("http://127.0.0.1:1", "t").allProgress()
      fail("no error")
    } catch (_: IOException) {}
    assertTrue(ApiClient.isTimeout(java.net.SocketTimeoutException()))
    assertTrue(ApiClient.isTimeout(java.io.InterruptedIOException("timeout")))
    assertFalse(ApiClient.isTimeout(java.net.ConnectException()))
  }
}

@OptIn(ExperimentalCoroutinesApi::class)
class AddressRouterTest {
  private val home = "http://192.168.1.10:8080"
  private val away = "https://books.example.com"
  private val account =
    Account("srv", "Home", 1, "ann", serverUrl = away, addresses = ServerAddresses(home, away), signedInAt = Instant.EPOCH)

  @Test
  fun neverHomeBeforeTheProbe() = runTest {
    var answer: String? = "srv"
    val router = AddressRouter(this) { answer }
    assertEquals("unproven: away", away, router.base(account))
    router.repick(account)
    assertEquals(home, router.base(account))
    router.leaveHome(account)
    assertEquals("left home on going to the background", away, router.base(account))
    answer = "another-box"
    router.repick(account)
    assertEquals("another box on the same private address", away, router.base(account))
  }

  @Test
  fun aPickNoLongerTheAccountsIsNotUsed() = runTest {
    val router = AddressRouter(this) { null }
    router.start("http://elsewhere:1")
    assertEquals(away, router.base(account))
    router.start(away)
    assertEquals(away, router.base(account))
    router.reset()
    assertNull(router.current.value)
  }

  @Test
  fun aProbeAnsweredAfterLeavingHomeIsDropped() = runTest {
    val gate = kotlinx.coroutines.CompletableDeferred<String?>()
    val router = AddressRouter(this) { gate.await() }
    val job = launch { router.repick(account) }
    runCurrent()
    router.leaveHome(account)
    gate.complete("srv")
    job.join()
    assertEquals(away, router.base(account))
  }

  /** A book server that only says which address it was asked at. */
  private class AskedAt(val base: String, val asked: MutableList<String>) : BookServer {
    override suspend fun renditionStatus(ref: BookRef): RenditionsAnswer {
      asked += base
      return RenditionsAnswer("watch", emptyList())
    }

    override suspend fun prepareRenditions(ref: BookRef): RenditionsAnswer = renditionStatus(ref)

    override suspend fun item(ref: BookRef): Book = error("not asked")

    override suspend fun chapters(ref: BookRef): ChaptersResponse = error("not asked")

    override suspend fun progress(ref: BookRef): ProgressRow? = null

    override suspend fun download(libraryId: Int, file: String, from: Long, ifRange: String?): Fetched = error("not asked")
  }

  @Test
  fun aBooksRunProvesAnAgingHomeAgainBeforeTheTokenGoesThere() = runTest {
    var answer: String? = "srv"
    var now = Instant.EPOCH
    var probes = 0
    val asked = ArrayList<String>()
    val ref = BookRef(1, "A/B")
    val server =
      ProvenBookServer(account, home, probe = { probes++; answer }, clock = { now }) { AskedAt(it, asked) }
    server.renditionStatus(ref)
    now = now.plusSeconds(89)
    server.renditionStatus(ref)
    assertEquals("the run's own pick stands for 90 s", 0, probes)
    now = now.plusSeconds(1)
    server.renditionStatus(ref)
    assertEquals(1, probes)
    assertEquals(listOf(home, home, home), asked)
    // Out of the door on the phone's connection: another box holds the address now.
    now = now.plusSeconds(90)
    answer = "another-box"
    server.prepareRenditions(ref)
    assertEquals(2, probes)
    assertEquals("asked with no token first, so the token goes away", away, asked.last())
    now = now.plusSeconds(600)
    server.renditionStatus(ref)
    assertEquals("an away pick needs no proof", 2, probes)
    assertEquals(away, asked.last())

    // A run that began away never probes.
    val out = ProvenBookServer(account, away, probe = { probes++; "srv" }, clock = { now.plusSeconds(1000) }) { AskedAt(it, asked) }
    out.renditionStatus(ref)
    assertEquals(2, probes)
  }

  @Test
  fun rechecksEvery90sWhileInFront() {
    val scope = TestScope(StandardTestDispatcher())
    var probes = 0
    val router = AddressRouter(scope) {
      probes++
      "srv"
    }
    router.startRechecks { account }
    scope.advanceTimeBy(89_000)
    scope.runCurrent()
    assertEquals(0, probes)
    scope.advanceTimeBy(2_000)
    scope.runCurrent()
    assertEquals(1, probes)
    router.stopRechecks()
    scope.advanceTimeBy(200_000)
    scope.runCurrent()
    assertEquals(1, probes)
  }
}

class ContinueListeningTest {
  private val server = MockWebServer()
  private val dir: File = NioFiles.createTempDirectory("continue").toFile()

  @Before
  fun setUp() = server.start()

  @After
  fun tearDown() {
    server.shutdown()
    dir.deleteRecursively()
  }

  private fun files() = Files(dir, File(dir, "nb"))

  private fun progressRow(path: String, updated: String) =
    """{"library_id":1,"path":"$path","position":30,"duration":100,"finished":false,"version":2,"updated_at":"$updated"}"""

  @Test
  fun readsEachItemOnceAndKeepsTheRows() = runTest {
    val files = files()
    val list = ContinueListening(files)
    val api = ApiClient(server.url("/").toString(), "t")
    server.enqueue(json("""{"progress":[${progressRow("A/One", "2026-11-02T00:00:00Z")},${progressRow("A/Two", "2026-11-01T00:00:00Z")}]}"""))
    server.enqueue(json("""{"rel_path":"A/One","title":"One","author":"Ann","duration":100}"""))
    server.enqueue(json("""{"rel_path":"A/Two","title":"Two","duration":100}"""))
    list.refresh(api)
    assertEquals(listOf("One", "Two"), list.rows.value.map { it.title })
    assertEquals(3, server.requestCount)
    assertEquals("", list.problem.value)
    assertFalse(list.loading.value)
    // Again: the items are kept, so only /me/progress is read.
    server.enqueue(json("""{"progress":[${progressRow("A/One", "2026-11-02T00:00:00Z")}]}"""))
    list.refresh(api)
    assertEquals(4, server.requestCount)
    assertEquals(listOf("One"), list.rows.value.map { it.title })
    assertEquals(listOf("One"), ContinueListening(files).rows.value.map { it.title })
    assertEquals(30.0, list.keptPlace(BookRef(1, "A/One"))!!.position, 0.0)
  }

  @Test
  fun aFailureKeepsTheRowsAndSaysWhy() = runTest {
    val list = ContinueListening(files())
    val api = ApiClient(server.url("/").toString(), "t")
    server.enqueue(json("""{"progress":[${progressRow("A/One", "2026-11-02T00:00:00Z")}]}"""))
    server.enqueue(json("""{"rel_path":"A/One","title":"One","duration":100}"""))
    list.refresh(api)
    server.enqueue(json("{}", 401))
    list.refresh(api)
    assertEquals(1, list.rows.value.size)
    assertEquals("Signed out. Set up the watch again from your phone.", list.problem.value)
    list.refresh(ApiClient("http://127.0.0.1:1", "t"))
    assertEquals(ContinueListening.CANT_REACH, list.problem.value)
    list.clear()
    assertTrue(list.rows.value.isEmpty())
  }
}
