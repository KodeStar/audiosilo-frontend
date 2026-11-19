package expo.modules.audiosiloplayer

import android.net.Uri
import androidx.media3.common.MediaMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The device run (FE-ANDROID check 6): System UI's resumption card never appeared after a
// reboot. The card is the book's playable browse item now ([CarBrowseTree.recentChildren] says
// why), as is the child of the recent root another browser asking for recent media gets.
class RecentItemsTest {
  private val authority = "app.audiosilo.dev.audiosilo.artwork"

  private fun item(id: String, downloaded: Boolean = true): CarItem {
    val book = BookRef("s.u", 2, id)
    val play = if (downloaded) {
      CarPlaySpec(book, listOf(TrackSpec("t", "file:///d/$id.m4b", "Chapter 3", null, null, null, 100.0)), emptyList(), 0, 0.0, 1.0)
    } else {
      null
    }
    return CarItem(id, "The Book", "The Author", 0.4, finished = false, downloaded = downloaded, artwork = null, play = play, book = book)
  }

  @Test fun theCardIsTheResumableBookAsAPlayableItem() {
    var granted = 0
    // (A JVM test: Android's stub Uri.parse answers null.)
    val items = CarBrowseTree.recentChildren(authority, item("book:a")) { _: Uri? -> granted++ }
    assertEquals(1, items.size)
    val card = items[0]
    assertEquals("book:a", card.mediaId)
    assertEquals(true, card.mediaMetadata.isPlayable)
    assertEquals(false, card.mediaMetadata.isBrowsable)
    // The book's title and author, never a chapter's.
    assertEquals("The Book", card.mediaMetadata.title)
    assertEquals("The Author", card.mediaMetadata.subtitle)
    assertEquals(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK, card.mediaMetadata.mediaType)
    // Its cover is granted, once (the URI itself: BrowseArtworkTest).
    assertEquals(1, granted)
  }

  @Test fun nothingResumableIsNoCard() {
    assertTrue(CarBrowseTree.recentChildren(authority, null) { }.isEmpty())
    // A book a resumption cannot start (streamed: no play spec) is never offered on the card.
    assertTrue(CarBrowseTree.recentChildren(authority, item("book:b", downloaded = false)) { }.isEmpty())
    // So a browser asking for recent media gets no recent root for either.
    assertFalse(CarBrowseTree.hasRecent(null))
    assertFalse(CarBrowseTree.hasRecent(item("book:b", downloaded = false)))
    assertTrue(CarBrowseTree.hasRecent(item("book:a")))
  }

  // The review: a browser subscribed to the recent root was never told its child changed (only
  // the car's root and tabs were), so it kept showing the book before.
  @Test fun theRecentRootChangesWithTheResumableBook() {
    val a = item("book:a")
    assertFalse(CarBrowseTree.recentChanged(null, null))
    assertTrue(CarBrowseTree.recentChanged(null, a))
    assertTrue(CarBrowseTree.recentChanged(a, null))
    assertTrue(CarBrowseTree.recentChanged(a, item("book:c")))
    assertTrue(CarBrowseTree.recentChanged(a, a.copy(progress = 0.5)))
    // A book no resumption can start is none.
    assertTrue(CarBrowseTree.recentChanged(a, item("book:a", downloaded = false)))
    assertFalse(CarBrowseTree.recentChanged(item("book:b", downloaded = false), null))
    // Where it resumes moves as it plays: the row shows the same.
    assertFalse(CarBrowseTree.recentChanged(a, a.copy(play = a.play?.copy(positionInTrack = 42.0))))
    assertEquals(1, CarBrowseTree.recentCount(a))
    assertEquals(0, CarBrowseTree.recentCount(null))
  }

  // System UI draws the card whoever Media3 names as asking: it always reads the cover, and so
  // does another asker, never the app itself twice.
  @Test fun theCardsCoverIsGrantedToWhoeverDrawsIt() {
    val own = "app.audiosilo.dev"
    assertEquals(listOf(ArtworkProvider.SYSTEM_UI), ArtworkProvider.cardReaders(own, own))
    assertEquals(listOf(ArtworkProvider.SYSTEM_UI), ArtworkProvider.cardReaders(ArtworkProvider.SYSTEM_UI, own))
    assertEquals(
      listOf(ArtworkProvider.SYSTEM_UI, "com.google.android.projection.gearhead"),
      ArtworkProvider.cardReaders("com.google.android.projection.gearhead", own),
    )
  }
}
