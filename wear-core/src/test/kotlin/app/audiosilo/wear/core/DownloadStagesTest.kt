// When a download is news for the phone: its stage moving (queued, preparing, downloading, ready,
// failed) is a `watch-state` change, from whichever thread moved it; bytes landing mid-download and
// a row's message are not (W4 plan, the Data Layer contract: StatePublication's rule).
package app.audiosilo.wear.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val REF = BookRef(1, "Author/Book")
private val QUEUED_AT = iso("2026-11-12T10:00:00Z")

private fun stateOf(vararg books: WatchStateBook) =
  WatchState(signedIn = true, serverId = "srv", userId = 1, appVersion = "2.7.0", books = books.toList(), unsentEvents = 0, couldntSync = 0)

private fun record(state: WatchStateBook.State, files: List<DownloadedFile> = emptyList(), message: String? = null) =
  DownloadRecord(ref = REF, title = "Book", folder = "f", state = state, files = files, message = message, addedAt = QUEUED_AT)

class DownloadStagesTest {
  @Test
  fun aStageChangeIsAChangeAndBytesAreNot() {
    val p = StatePublication()
    val half = listOf(DownloadedFile("a.mp3", "a.mp3", 100, true), DownloadedFile("b.mp3", "b.mp3"))
    val all = listOf(DownloadedFile("a.mp3", "a.mp3", 100, true), DownloadedFile("b.mp3", "b.mp3", 200, true))
    assertTrue(p.update(stateOf(record(WatchStateBook.State.QUEUED).stateBook())))
    assertTrue(p.update(stateOf(record(WatchStateBook.State.PREPARING).stateBook())))
    assertFalse(p.update(stateOf(record(WatchStateBook.State.PREPARING, message = BookDownload.WAITING_FOR_SERVER).stateBook())))
    assertTrue(p.update(stateOf(record(WatchStateBook.State.DOWNLOADING).stateBook())))
    // Files landing while it downloads: the same state, so nothing to send.
    assertFalse(p.update(stateOf(record(WatchStateBook.State.DOWNLOADING, half).stateBook())))
    assertFalse(p.update(stateOf(record(WatchStateBook.State.DOWNLOADING, all).stateBook())))
    assertTrue(p.update(stateOf(record(WatchStateBook.State.READY, all).stateBook())))
    assertTrue(p.update(stateOf(record(WatchStateBook.State.FAILED, all).stateBook())))
  }

  @Test
  fun onlyAReadyBookReportsItsSize() {
    val files = listOf(DownloadedFile("a.mp3", "a.mp3", 100, true))
    assertNull(record(WatchStateBook.State.DOWNLOADING, files).stateBook().bytes)
    assertEquals(100L, record(WatchStateBook.State.READY, files).stateBook().bytes)
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun theIndexSaysEachStageAndNothingElse() = runTest {
    val index = DownloadIndex(null)
    val seen = ArrayList<List<WatchStateBook>>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { index.stages.collect { seen += it } }

    index.enqueue(REF, "Book", null, QUEUED_AT)
    index.update(REF) { it.copy(state = WatchStateBook.State.PREPARING) }
    index.update(REF) { it.copy(message = BookDownload.WAITING_FOR_SERVER) }
    index.update(REF) { it.copy(waitingForWifi = true) }
    index.update(REF) { it.copy(state = WatchStateBook.State.DOWNLOADING, message = null, files = listOf(DownloadedFile("a.mp3", "a.mp3"))) }
    index.update(REF) { r -> r.copy(files = r.files.map { it.copy(bytes = 100, done = true) }) }
    index.update(REF) { it.copy(state = WatchStateBook.State.READY) }
    index.remove(REF)

    assertEquals(
      listOf(
        emptyList(),
        listOf(WatchStateBook(REF, "Book", WatchStateBook.State.QUEUED)),
        listOf(WatchStateBook(REF, "Book", WatchStateBook.State.PREPARING)),
        listOf(WatchStateBook(REF, "Book", WatchStateBook.State.DOWNLOADING)),
        listOf(WatchStateBook(REF, "Book", WatchStateBook.State.READY, 100)),
        emptyList(),
      ),
      seen,
    )
  }
}
