// What the screens say (pure functions beside the composables).
package app.audiosilo.wear

import app.audiosilo.wear.core.BookMessage
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.DownloadRecord
import app.audiosilo.wear.core.DownloadedFile
import app.audiosilo.wear.core.HeldBook
import app.audiosilo.wear.core.WatchStateBook
import app.audiosilo.wear.ui.PREPARING_HINT
import app.audiosilo.wear.ui.bookRowLines
import app.audiosilo.wear.ui.heldLine
import app.audiosilo.wear.ui.tooOldMessage
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class ScreensTest {
  private fun record(state: WatchStateBook.State, files: List<DownloadedFile> = emptyList(), message: String? = null) =
    DownloadRecord(BookRef(1, "A/B"), "Book", null, "f", state, files, message, Instant.EPOCH)

  @Test
  fun aBookRowSaysWhereItStands() {
    val files = listOf(DownloadedFile("1", "000.m4a", 1_500_000, true), DownloadedFile("2", "001.m4a", 2_000_000, false))
    assertEquals(listOf("3.5 MB"), bookRowLines(record(WatchStateBook.State.READY, files, message = "old")))
    assertEquals(listOf("Downloading 1 of 2 files"), bookRowLines(record(WatchStateBook.State.DOWNLOADING, files)))
    assertEquals(listOf("Preparing on the server", PREPARING_HINT), bookRowLines(record(WatchStateBook.State.PREPARING, files)))
    assertEquals(listOf("Preparing on the server"), bookRowLines(record(WatchStateBook.State.PREPARING)))
    assertEquals(
      listOf("Waiting to download", "Waiting for Wi-Fi"),
      bookRowLines(record(WatchStateBook.State.QUEUED, message = "Waiting for Wi-Fi")),
    )
    assertEquals(listOf("Couldn't download", "No."), bookRowLines(record(WatchStateBook.State.FAILED, message = "No.")))
  }

  @Test
  fun heldAndTooOld() {
    val b = BookMessage("srv", 1, BookRef(1, "A/B"), "Book")
    assertEquals("Waiting until this watch can take it", heldLine(HeldBook(b, Instant.EPOCH)))
    assertEquals("Not delivered. Send it again from your phone.", heldLine(HeldBook(b, Instant.EPOCH, Instant.EPOCH)))
    assertEquals("This server can't make books for the watch. It needs ffmpeg.", tooOldMessage(true))
    assertEquals("This server is too old for the watch app (needs 2.6 or later).", tooOldMessage(false))
  }
}
