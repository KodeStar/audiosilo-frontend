package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LoadedFilesTest {
  private fun item(path: String?, index: Int) = LoadedFiles.Item(path, index)
  private fun track(id: String) = TrackSpec(id, "file:///x", "T", null, null, null, 0.0)

  @Test fun wholeFileItemsGiveTheirPathsInFileOrder() {
    assertEquals(
      listOf("A/Book/10.mp3", "A/Book/2.mp3"),
      LoadedFiles.paths(listOf(item("A/Book/10.mp3", 0), item("A/Book/2.mp3", 1))),
    )
  }

  @Test fun chapterClipsNameTheirFileOnce() {
    assertEquals(
      listOf("A/Book/part 1.m4b", "A/Book/part 2.m4b"),
      LoadedFiles.paths(
        listOf(
          item("A/Book/part 1.m4b", 0),
          item("A/Book/part 1.m4b", 0),
          item("A/Book/part 2.m4b", 1),
        ),
      ),
    )
  }

  @Test fun anUnreadableQueueIsNull() {
    assertNull(LoadedFiles.paths(emptyList()))
    // An item without a path (no extras, or a track id of another shape).
    assertNull(LoadedFiles.paths(listOf(item("A/a.mp3", 0), item(null, 1))))
    // A file index with no item, and two items of one file that disagree.
    assertNull(LoadedFiles.paths(listOf(item("A/a.mp3", 0), item("A/c.mp3", 2))))
    assertNull(LoadedFiles.paths(listOf(item("A/a.mp3", 0), item("A/b.mp3", 0))))
    assertNull(LoadedFiles.paths(listOf(item("A/a.mp3", -1))))
  }

  // fe#172: the path an item's extras carry comes from its TRACK id, never from the item's media
  // id (a clip's adds `#<startInFile>`), so a path that ends like a clip suffix stays whole.
  @Test fun aTrackNamesItsFileFromItsId() {
    assertEquals("A/#1: Book/01.mp3", track("12:A/#1: Book/01.mp3").relPath)
    assertEquals("A/Book/Part #2", track("1:A/Book/Part #2").relPath)
    assertEquals("A/Book/2.mp3", LoadedFiles.pathOf("1:A/Book/2.mp3"))
    assertNull(track("no-library-id").relPath)
    assertNull(LoadedFiles.pathOf("1:"))
    assertNull(LoadedFiles.pathOf(":A/x.mp3"))
  }
}
