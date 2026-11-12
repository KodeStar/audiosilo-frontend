// Wear's own: the downloads index, Continue listening's rows and one book's download run
// (W4 decision 8: prepare, poll at retry_after with 15 s at least for 30 minutes, the free-space
// rule, Range + If-Range resume, idempotent re-runs). No Swift twin: the Apple Watch hands the
// bytes to a background session.
package app.audiosilo.wear.core

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val REF = BookRef(3, "Author/Book")
private val T0: Instant = instantAt(1_800_000_000.0)

private fun bookFile(path: String, seq: Int, duration: Double) = BookFile(path, seq, duration, "mp3", 1000)

private val BOOK =
  Book(
    libraryId = 3,
    relPath = "Author/Book",
    title = "The Book",
    author = "Ann",
    duration = 120.0,
    files = listOf(bookFile("Author/Book/01.mp3", 1, 60.0), bookFile("Author/Book/02.mp3", 2, 60.0)),
  )

private fun ready(path: String, bytes: Long) = RenditionFile(path = path, state = "ready", bytes = bytes)

private fun pending(path: String, retry: Double? = null) = RenditionFile(path = path, state = "pending", retryAfterSeconds = retry)

private class FakeServer(val content: Map<String, ByteArray>) : BookServer {
  val answers = ArrayDeque<() -> RenditionsAnswer>()
  var chaptersError: APIError? = null
  var itemReads = 0
  val downloads = ArrayList<Triple<String, Long, String?>>()
  var etag: String? = "\"v1\""
  /** Cut each download after this many bytes (IOException), once. */
  var cutAfter: Int? = null
  var downloadError: Exception? = null

  override suspend fun item(ref: BookRef): Book {
    itemReads++
    return BOOK
  }

  override suspend fun chapters(ref: BookRef): ChaptersResponse {
    chaptersError?.let { throw it }
    return ChaptersResponse(duration = 120.0, files = BOOK.files, chapters = emptyList())
  }

  override suspend fun progress(ref: BookRef): ProgressRow? = null

  private fun next(): RenditionsAnswer =
    (answers.removeFirstOrNull() ?: { RenditionsAnswer("watch", content.map { (p, b) -> ready(p, b.size.toLong()) }) })()

  override suspend fun prepareRenditions(ref: BookRef): RenditionsAnswer = next()

  override suspend fun renditionStatus(ref: BookRef): RenditionsAnswer = next()

  override suspend fun download(libraryId: Int, file: String, from: Long, ifRange: String?): Fetched {
    downloadError?.let {
      downloadError = null
      throw it
    }
    downloads += Triple(file, from, ifRange)
    val all = content.getValue(file)
    val resume = from > 0 && ifRange == etag
    // As the server answers a Range that starts at or past the file's end.
    if (resume && from >= all.size) throw APIError(416)
    val bytes = if (resume) all.copyOfRange(from.toInt(), all.size) else all
    val cut = cutAfter
    val body =
      if (cut != null) {
        cutAfter = null
        object : java.io.InputStream() {
          var i = 0

          override fun read(): Int {
            if (i >= cut) throw IOException("cut")
            return if (i < bytes.size) bytes[i++].toInt() and 0xff else -1
          }

          override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (i >= cut) throw IOException("cut")
            if (i >= bytes.size) return -1
            val n = minOf(len, bytes.size - i, cut - i)
            System.arraycopy(bytes, i, b, off, n)
            i += n
            return n
          }
        }
      } else {
        ByteArrayInputStream(bytes)
      }
    return Fetched(if (resume) 206 else 200, etag, body)
  }
}

private class DirStorage(val root: File, var free: Long? = 10_000_000_000) : BookStorage {
  private val items = HashMap<BookRef, ItemCache>()

  override fun folder(record: DownloadRecord) = File(root, record.folder)

  override fun saveItem(ref: BookRef, cache: ItemCache) {
    items[ref] = cache
  }

  override fun loadItem(ref: BookRef) = items[ref]

  override fun freeBytes() = free
}

class BookDownloadTest {
  private val dir = tempDir()
  private val sleeps = ArrayList<Double>()
  private var now = T0

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  private val content =
    mapOf("Author/Book/01.mp3" to ByteArray(3000) { it.toByte() }, "Author/Book/02.mp3" to ByteArray(2000) { (it * 7).toByte() })

  private fun index() = DownloadIndex(File(dir, "downloads.json")) { "folder-1" }

  private fun run(server: BookServer, index: DownloadIndex, storage: DirStorage = DirStorage(dir)) =
    BookDownload(server, index, storage, REF, clock = { now }, sleep = { sleeps += it; now = now.addingSeconds(it) })

  @Test
  fun preparesPollsAndDownloadsInPlayOrder() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    server.answers += { RenditionsAnswer("watch", listOf(pending("Author/Book/01.mp3", 40.0), pending("Author/Book/02.mp3"))) }
    server.answers += { RenditionsAnswer("watch", listOf(ready("Author/Book/01.mp3", 3000), pending("Author/Book/02.mp3", 3.0))) }
    assertEquals(BookDownload.Outcome.Done, run(server, idx).run())
    assertEquals("the server's 40 s, then never under 15 s", listOf(40.0, 15.0), sleeps)
    val r = idx.record(REF)!!
    assertEquals(WatchStateBook.State.READY, r.state)
    assertEquals("The Book", r.title)
    assertEquals("Ann", r.author)
    assertEquals(listOf("000.m4a", "001.m4a"), r.files.map { it.local })
    assertEquals(5000L, r.bytes)
    assertTrue(content.getValue("Author/Book/01.mp3").contentEquals(File(dir, "folder-1/000.m4a").readBytes()))
    assertTrue(content.getValue("Author/Book/02.mp3").contentEquals(File(dir, "folder-1/001.m4a").readBytes()))
    assertFalse("no part or etag left", File(dir, "folder-1").list()!!.any { it.endsWith(".part") || it.endsWith(".etag") })
  }

  @Test
  fun aCutFileResumesWithRangeAndIfRange() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    server.cutAfter = 1000
    assertEquals(BookDownload.Outcome.Retry, run(server, idx).run())
    assertEquals(BookDownload.WAITING_FOR_CONNECTION, idx.record(REF)!!.message)
    assertEquals(1000L, File(dir, "folder-1/000.m4a.part").length())
    // The worker runs again (a new process): it carries on from byte 1000.
    assertEquals(BookDownload.Outcome.Done, run(server, idx).run())
    assertEquals(Triple("Author/Book/01.mp3", 1000L, "\"v1\""), server.downloads[1])
    assertEquals("the item is read once", 1, server.itemReads)
    assertTrue(content.getValue("Author/Book/01.mp3").contentEquals(File(dir, "folder-1/000.m4a").readBytes()))
  }

  @Test
  fun aChangedFileStartsAgainFromZero() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    server.cutAfter = 1000
    run(server, idx).run()
    server.etag = "\"v2\""
    assertEquals(BookDownload.Outcome.Done, run(server, idx).run())
    assertEquals("asked to resume, answered whole", Triple("Author/Book/01.mp3", 1000L, "\"v1\""), server.downloads[1])
    assertTrue(content.getValue("Author/Book/01.mp3").contentEquals(File(dir, "folder-1/000.m4a").readBytes()))
  }

  @Test
  fun aPartAlreadyWholeStartsAgainInsteadOfFailing() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    server.cutAfter = 1000
    run(server, idx).run()
    // Killed after the last byte and before the rename: the part holds the whole file.
    File(dir, "folder-1/000.m4a.part").writeBytes(content.getValue("Author/Book/01.mp3"))
    assertEquals(BookDownload.Outcome.Done, run(server, idx).run())
    assertEquals("asked for what is past the end (416)", Triple("Author/Book/01.mp3", 3000L, "\"v1\""), server.downloads[1])
    assertEquals("then the whole file", Triple("Author/Book/01.mp3", 0L, null), server.downloads[2])
    assertTrue(content.getValue("Author/Book/01.mp3").contentEquals(File(dir, "folder-1/000.m4a").readBytes()))
    assertEquals(WatchStateBook.State.READY, idx.record(REF)!!.state)
  }

  @Test
  fun aWeakETagIsNeverSentAsIfRange() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    server.etag = "W/\"v1\""
    server.cutAfter = 1000
    run(server, idx).run()
    run(server, idx).run()
    assertEquals(Triple("Author/Book/01.mp3", 0L, null), server.downloads[1])
    assertFalse(BookDownload.isStrong("W/\"v1\""))
    assertTrue(BookDownload.isStrong("\"v1\""))
  }

  @Test
  fun aRerunSkipsWhatLanded() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    run(server, idx).run()
    idx.update(REF) { it.copy(state = WatchStateBook.State.DOWNLOADING) }
    val before = server.downloads.size
    assertEquals(BookDownload.Outcome.Done, run(server, idx).run())
    assertEquals(before, server.downloads.size)
  }

  @Test
  fun refusedWhenItWouldNotLeave200MBFree() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val storage = DirStorage(dir, free = RenditionPlan.HEADROOM_BYTES + 4999)
    assertEquals(BookDownload.Outcome.Failed, run(FakeServer(content), idx, storage).run())
    val r = idx.record(REF)!!
    assertEquals(WatchStateBook.State.FAILED, r.state)
    assertEquals(
      "Not enough space on this watch: it needs 5 KB and keeps 200 MB free; 200 MB is free.",
      r.message,
    )
    storage.free = RenditionPlan.HEADROOM_BYTES + 5000
    idx.enqueue(REF, "Book", null, T0)
    assertEquals(BookDownload.Outcome.Done, run(FakeServer(content), idx, storage).run())
  }

  @Test
  fun thirtyMinutesOfPreparingHandsOverToTheBackoff() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    repeat(200) { server.answers += { RenditionsAnswer("watch", listOf(pending("Author/Book/01.mp3", 60.0), pending("Author/Book/02.mp3"))) } }
    assertEquals(BookDownload.Outcome.Retry, run(server, idx).run())
    assertEquals(30, sleeps.size)
    assertEquals(BookDownload.WAITING_FOR_SERVER, idx.record(REF)!!.message)
    assertEquals(WatchStateBook.State.PREPARING, idx.record(REF)!!.state)
  }

  @Test
  fun aPendingRefusalWaitsThenCarriesOn() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    server.downloadError = APIError(503, "rendition_pending", null, 20.0)
    assertEquals(BookDownload.Outcome.Done, run(server, idx).run())
    assertEquals(listOf(20.0), sleeps)
  }

  @Test
  fun refusalsEndWithTheirMessage() = runTest {
    for ((error, message) in
      listOf(
        APIError(401) to "Signed out. Set up the watch again from your phone.",
        APIError(404, "not_found") to "This book is no longer on the server.",
        APIError(422, "rendition_failed") to "A file of this book can't be made for the watch.",
        APIError(404, "rendition_unavailable") to "This server can't make books for the watch now.",
      )) {
      val idx = DownloadIndex(null) { "f" }
      idx.enqueue(REF, "Book", null, T0)
      val server = FakeServer(content)
      server.downloadError = error
      assertEquals(BookDownload.Outcome.Failed, run(server, idx).run())
      assertEquals(message, idx.record(REF)!!.message)
    }
  }

  @Test
  fun noChaptersIsKeptOnlyForItsOwnAnswer() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    server.chaptersError = APIError(404, "not_found")
    assertEquals(BookDownload.Outcome.Done, run(server, idx).run())
    val passing = DownloadIndex(null) { "g" }
    passing.enqueue(REF, "Book", null, T0)
    server.chaptersError = APIError(500)
    assertEquals("a passing failure is not kept as no chapters", BookDownload.Outcome.Retry, run(server, passing).run())
    assertTrue(passing.record(REF)!!.files.isEmpty())
  }

  @Test
  fun anAnswerWithoutTheBooksFilesFailsAndForgetsThem() = runTest {
    val idx = index()
    idx.enqueue(REF, "Book", null, T0)
    val server = FakeServer(content)
    server.answers += { RenditionsAnswer("watch", listOf(ready("Author/Book/other.mp3", 10))) }
    assertEquals(BookDownload.Outcome.Failed, run(server, idx).run())
    assertEquals(BookDownload.CHANGED_ON_SERVER, idx.record(REF)!!.message)
    assertTrue(idx.record(REF)!!.files.isEmpty())
  }

  @Test
  fun aRemovedRecordEndsTheRun() = runTest {
    val idx = index()
    assertEquals(BookDownload.Outcome.Gone, run(FakeServer(content), idx).run())
  }
}

class DownloadIndexTest {
  private val dir = tempDir()

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun queuesOnceAndRetriesOnlyAFailedBook() {
    val idx = DownloadIndex(null) { "f" }
    assertTrue(idx.enqueue(REF, "Book", null, T0))
    assertFalse("already on its way", idx.enqueue(REF, "Book", null, T0))
    idx.update(REF) { it.copy(state = WatchStateBook.State.FAILED, message = "no") }
    assertTrue(idx.enqueue(REF, "Book", null, T0))
    assertEquals(WatchStateBook.State.QUEUED, idx.record(REF)!!.state)
    assertNull(idx.record(REF)!!.message)
  }

  @Test
  fun survivesAKillAndForgetsTheFileWhenEmpty() {
    val file = File(dir, "downloads.json")
    val idx = DownloadIndex(file) { "f" }
    idx.enqueue(REF, "Book", "Ann", T0, sentAt = T0.addingSeconds(-5.0))
    val again = DownloadIndex(file)
    assertEquals(idx.records.value, again.records.value)
    assertEquals(T0.addingSeconds(-5.0), again.record(REF)!!.queuedAt)
    again.removeAll()
    assertFalse(file.exists())
    assertTrue(again.saved)
  }

  @Test
  fun anUnsavedIndexSaysSo() {
    val blocker = File(dir, "blocker").apply { writeText("x") }
    val idx = DownloadIndex(File(blocker, "downloads.json"))
    idx.enqueue(REF, "Book", null, T0)
    assertFalse(idx.saved)
    assertEquals(1, idx.records.value.size)
  }

  @Test
  fun anUpdateOfAGoneRecordIsNothing() {
    val idx = DownloadIndex(null)
    assertNull(idx.update(REF) { it.copy(title = "x") })
    assertNull(idx.remove(REF))
  }

  @Test
  fun aRecordQueuedWithoutTheSendTimeUsesItsOwn() {
    val idx = DownloadIndex(null)
    idx.enqueue(REF, "Book", null, T0)
    assertEquals(T0, idx.record(REF)!!.queuedAt)
  }
}

class ContinueRowsTest {
  private fun row(path: String, updated: String, position: Double = 10.0, finished: Boolean = false, duration: Double = 100.0) =
    ProgressRow(libraryId = 1, path = path, position = position, duration = duration, finished = finished, version = 4, updatedAt = updated)

  @Test
  fun titlesFromTheCacheElseOneReadElseTheFileName() = runTest {
    val fetched = ArrayList<BookRef>()
    val rows =
      ContinueRows.build(
        listOf(row("A/Cached", "2026-11-03T00:00:00Z"), row("A/Fetched", "2026-11-02T00:00:00Z"), row("A/Nothing", "2026-11-01T00:00:00Z")),
        cached = { if (it.path == "A/Cached") BOOK.copy(title = "Cached") else null },
        fetch = {
          fetched += it
          if (it.path == "A/Fetched") BOOK.copy(title = "Fetched", author = "Bo") else null
        },
      )!!
    assertEquals(listOf("Cached", "Fetched", "Nothing"), rows.map { it.title })
    assertEquals(listOf("A/Fetched", "A/Nothing"), fetched.map { it.path })
    assertEquals("Bo", rows[1].author)
    assertEquals(0.1, rows[0].fraction, 1e-9)
  }

  @Test
  fun atMostTenReads() = runTest {
    var reads = 0
    val all = (0 until 15).map { row("A/$it", "2026-11-%02dT00:00:00Z".format(it + 1)) }
    val rows = ContinueRows.build(all, cached = { null }, fetch = { reads++; null })!!
    assertEquals(ContinueRows.LIMIT, rows.size)
    assertEquals(ContinueRows.LIMIT, reads)
  }

  @Test
  fun aRefreshNoLongerWantedGivesNothing() = runTest {
    var wanted = true
    val rows =
      ContinueRows.build(
        listOf(row("A/1", "2026-11-03T00:00:00Z"), row("A/2", "2026-11-02T00:00:00Z")),
        cached = { null },
        fetch = {
          wanted = false
          null
        },
        stillWanted = { wanted },
      )
    assertNull(rows)
  }

  @Test
  fun theKeptPlaceIsTheRowsServerPlace() {
    val r = ContinueRow(REF, "T", null, 42.0, 100.0, "2026-11-03T00:00:00Z", 7, "dev", 1.5)
    val p = r.keptPlace()
    assertEquals(42.0, p.position, 0.0)
    assertEquals(7, p.version)
    assertEquals("dev", p.deviceId)
    assertEquals(1.5, p.playbackSpeed)
    assertEquals(REF, p.ref)
  }
}

class LabelsTest {
  @Test
  fun bytesInDecimalUnits() {
    assertEquals("0 bytes", Labels.bytes(0))
    assertEquals("1 byte", Labels.bytes(1))
    assertEquals("999 bytes", Labels.bytes(999))
    assertEquals("5 KB", Labels.bytes(5000))
    assertEquals("200 MB", Labels.bytes(200_000_000))
    assertEquals("3.4 MB", Labels.bytes(3_400_000))
    assertEquals("1.2 GB", Labels.bytes(1_234_000_000))
    assertEquals("2 GB", Labels.bytes(2_000_000_000))
  }

  @Test
  fun clockAndStates() {
    assertEquals("0:00", Labels.clock(-3.0))
    assertEquals("2:03", Labels.clock(123.4))
    assertEquals("1:02:03", Labels.clock(3723.0))
    assertEquals("0:00", Labels.clock(Double.NaN))
    assertEquals("Couldn't download", Labels.state(WatchStateBook.State.FAILED))
    assertEquals("1 listening update has", Labels.updates(1))
    assertEquals("3 listening updates have", Labels.updates(3))
  }
}
