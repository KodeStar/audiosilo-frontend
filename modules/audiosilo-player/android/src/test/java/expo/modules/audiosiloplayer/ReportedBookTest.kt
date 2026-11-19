package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Test

class ReportedBookTest {
  @Test fun aReportNamesTheLoadedBookInJsTerms() {
    val report = mapOf("index" to 3) + reportedBook(BookRef("srv.1", 7, "Author/Book"), null)
    assertEquals(
      mapOf(
        "index" to 3,
        "book" to mapOf("connectionId" to "srv.1", "libraryId" to 7.0, "path" to "Author/Book"),
      ),
      report,
    )
  }

  @Test fun aReportOfAnItemLoadedWithoutABookNamesNone() {
    assertEquals(mapOf("state" to "playing"), mapOf("state" to "playing") + reportedBook(null, null))
  }

  private val left = BookRef("srv.1", 7, "Author/Left")
  private val now = BookRef("srv.1", 7, "Author/Now")

  // FE-ANDROID-2: the service's reports name the book the service's own item belongs to, the one
  // it passes, never another the module's controller (a message behind) still shows.
  @Test fun aRateChangeNamesTheBookTheServiceSetItOn() {
    assertEquals(mapOf("rate" to 1.5, "book" to now.toEvent()), rateChangeEvent(1.5, now, null))
  }

  @Test fun aFailedEngineNamesTheBookTheServiceHadLoaded() {
    assertEquals(
      mapOf("state" to "error", "playWhenReady" to false, "book" to now.toEvent()),
      failedStateEvent(now, null),
    )
  }

  // A move held until the controller caught up (or for the 300 ms fallback) still names the book
  // it was made in when it is sent, even if the engine has moved on to another book since.
  @Test fun aHeldRemoteMoveNamesTheBookItWasMadeIn() {
    assertEquals(
      mapOf("trackIndex" to 2, "position" to 31.5, "book" to left.toEvent()),
      RemoteMove(2, 31.5, left, null).toEvent(),
    )
  }

  @Test fun reportsOfAnItemWithoutABookNameNone() {
    assertEquals(mapOf("rate" to 1.0), rateChangeEvent(1.0, null, null))
    assertEquals(mapOf("state" to "error", "playWhenReady" to false), failedStateEvent(null, null))
    assertEquals(mapOf("trackIndex" to 0, "position" to 4.0), RemoteMove(0, 4.0, null, null).toEvent())
  }

  // FE-ANDROID-5: a report carries the tag of the app's load its item came from, so JS drops one
  // of a load a later one superseded (sent before it, heard after).
  @Test fun aReportOfAnAppLoadCarriesItsTag() {
    assertEquals(
      mapOf("state" to "playing", "book" to now.toEvent(), "load" to 42.0),
      mapOf("state" to "playing") + reportedBook(now, 42.0),
    )
    assertEquals(mapOf("rate" to 1.5, "book" to now.toEvent(), "load" to 42.0), rateChangeEvent(1.5, now, 42.0))
    assertEquals(
      mapOf("state" to "error", "playWhenReady" to false, "book" to now.toEvent(), "load" to 42.0),
      failedStateEvent(now, 42.0),
    )
    assertEquals(
      mapOf("trackIndex" to 2, "position" to 31.5, "book" to left.toEvent(), "load" to 41.0),
      RemoteMove(2, 31.5, left, 41.0).toEvent(),
    )
  }

  // A queue the service loaded itself has no tag, and a tag goes only with a book.
  @Test fun aReportWithoutATagOrABookCarriesNone() {
    assertEquals(mapOf("book" to now.toEvent()), reportedBook(now, null))
    assertEquals(emptyMap<String, Any>(), reportedBook(null, 42.0))
  }
}
