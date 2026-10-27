package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LoadedFilesTest {
  private fun file(id: String, index: Int) = LoadedFiles.Item(id, index, clip = false)
  private fun clip(id: String, index: Int, start: Double) = LoadedFiles.Item("$id#$start", index, clip = true)

  @Test fun wholeFileItemsGiveTheirPathsInFileOrder() {
    assertEquals(
      listOf("A/Book/10.mp3", "A/Book/2.mp3"),
      LoadedFiles.paths(listOf(file("1:A/Book/10.mp3", 0), file("1:A/Book/2.mp3", 1))),
    )
  }

  @Test fun chapterClipsNameTheirFileOnce() {
    assertEquals(
      listOf("A/Book/part 1.m4b", "A/Book/part 2.m4b"),
      LoadedFiles.paths(
        listOf(
          clip("1:A/Book/part 1.m4b", 0, 0.0),
          clip("1:A/Book/part 1.m4b", 0, 312.5),
          clip("1:A/Book/part 2.m4b", 1, 0.0),
        ),
      ),
    )
  }

  @Test fun aPathKeepsItsOwnHashAndColon() {
    assertEquals(
      listOf("A/#1: Book/01.mp3"),
      LoadedFiles.paths(listOf(clip("12:A/#1: Book/01.mp3", 0, 0.0))),
    )
  }

  @Test fun anUnreadableQueueIsNull() {
    assertNull(LoadedFiles.paths(emptyList()))
    assertNull(LoadedFiles.paths(listOf(file("no-library-id", 0))))
    assertNull(LoadedFiles.paths(listOf(file("1:", 0))))
    assertNull(LoadedFiles.paths(listOf(LoadedFiles.Item("1:A/x.mp3", 0, clip = true))))
    // A file index with no item, and two items of one file that disagree.
    assertNull(LoadedFiles.paths(listOf(file("1:A/a.mp3", 0), file("1:A/c.mp3", 2))))
    assertNull(LoadedFiles.paths(listOf(clip("1:A/a.mp3", 0, 0.0), clip("1:A/b.mp3", 0, 10.0))))
    assertNull(LoadedFiles.paths(listOf(file("1:A/a.mp3", -1))))
  }
}
