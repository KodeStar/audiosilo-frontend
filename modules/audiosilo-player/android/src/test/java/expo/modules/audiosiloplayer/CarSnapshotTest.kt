package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CarSnapshotTest {
  private val labels = CarLabels("", "", "", "", "")

  private fun item(id: String, downloaded: Boolean = true): CarItem {
    val book = BookRef("s.u", 2, id)
    val play = if (downloaded) {
      CarPlaySpec(book, listOf(TrackSpec("t", "file:///d/$id.m4b", id, null, null, null, 100.0)), emptyList(), 0, 0.0, 1.0)
    } else {
      null
    }
    return CarItem(id, id, "", null, finished = false, downloaded = downloaded, artwork = null, play = play, book = book)
  }

  private fun snapshot(resume: String?, namesResume: Boolean = true) = CarSnapshot(
    labels,
    signedIn = true,
    tabs = listOf(
      CarTab("continue", "Continue", listOf(item("newest"), item("streamed", downloaded = false))),
      CarTab("downloads", "Downloads", listOf(item("newest"), item("paused"))),
    ),
    resume = resume,
    namesResume = namesResume,
  )

  @Test fun aResumptionStartsTheBookJsNamed() {
    assertEquals("paused", snapshot("paused").resumable()?.id)
  }

  // A stopped or finished book: JS names none, and the newest book in progress stays stopped.
  @Test fun noBookNamedIsNothingToResume() {
    assertNull(snapshot(null).resumable())
  }

  @Test fun aNamedBookThatIsNotListedOrNotDownloadedIsNothingToResume() {
    assertNull(snapshot("gone").resumable())
    assertNull(snapshot("streamed").resumable())
  }

  // A snapshot kept from before JS named the book: the first Continue listening book, as it was.
  @Test fun anOlderSnapshotResumesItsFirstContinueBook() {
    assertEquals("newest", snapshot(null, namesResume = false).resumable()?.id)
  }
}
