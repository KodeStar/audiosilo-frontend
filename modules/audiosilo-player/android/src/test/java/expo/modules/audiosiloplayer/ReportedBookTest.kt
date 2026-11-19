package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Test

class ReportedBookTest {
  @Test fun aReportNamesTheLoadedBookInJsTerms() {
    val report = mapOf("index" to 3) + reportedBook(BookRef("srv.1", 7, "Author/Book"))
    assertEquals(
      mapOf(
        "index" to 3,
        "book" to mapOf("connectionId" to "srv.1", "libraryId" to 7.0, "path" to "Author/Book"),
      ),
      report,
    )
  }

  @Test fun aReportOfAnItemLoadedWithoutABookNamesNone() {
    assertEquals(mapOf("state" to "playing"), mapOf("state" to "playing") + reportedBook(null))
  }

  private val left = BookRef("srv.1", 7, "Author/Left")
  private val now = BookRef("srv.1", 7, "Author/Now")

  // FE-ANDROID-2: the service's reports name the book the service's own item belongs to, the one
  // it passes, never another the module's controller (a message behind) still shows.
  @Test fun aRateChangeNamesTheBookTheServiceSetItOn() {
    assertEquals(mapOf("rate" to 1.5, "book" to now.toEvent()), rateChangeEvent(1.5, now))
  }

  @Test fun aFailedEngineNamesTheBookTheServiceHadLoaded() {
    assertEquals(
      mapOf("state" to "error", "playWhenReady" to false, "book" to now.toEvent()),
      failedStateEvent(now),
    )
  }

  // A move held until the controller caught up (or for the 300 ms fallback) still names the book
  // it was made in when it is sent, even if the engine has moved on to another book since.
  @Test fun aHeldRemoteMoveNamesTheBookItWasMadeIn() {
    assertEquals(
      mapOf("trackIndex" to 2, "position" to 31.5, "book" to left.toEvent()),
      RemoteMove(2, 31.5, left).toEvent(),
    )
  }

  @Test fun reportsOfAnItemWithoutABookNameNone() {
    assertEquals(mapOf("rate" to 1.0), rateChangeEvent(1.0, null))
    assertEquals(mapOf("state" to "error", "playWhenReady" to false), failedStateEvent(null))
    assertEquals(mapOf("trackIndex" to 0, "position" to 4.0), RemoteMove(0, 4.0, null).toEvent())
  }
}
