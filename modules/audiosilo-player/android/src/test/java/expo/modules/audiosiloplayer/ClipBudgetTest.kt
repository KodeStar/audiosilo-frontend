package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClipBudgetTest {
  private val mb = 1024L * 1024

  private fun track(path: String, hours: Double, url: String? = null) = TrackSpec(
    id = "1:$path",
    url = url ?: "http://127.0.0.1:18431/api/v1/libraries/1/stream?path=${path.replace("/", "%2F").replace(" ", "%20")}&token=t",
    title = "Book",
    album = null,
    artist = null,
    artwork = null,
    duration = hours * 3600,
  )

  private fun chapters(file: Int, n: Int) = List(n) { ClipSpec(file, it * 600.0, (it + 1) * 600.0, "Chapter ${it + 1}") }

  // Loyalists (fe#194): 23.5 h, one m4b, 94 chapters.
  private val loyalists = track("Brian J. Nordon/Quest Academy/QA06 - Loyalists/Loyalists.m4b", 84702.7 / 3600)

  @Test fun aLongM4bDoesNotClipInTheDefaultHeap() {
    assertFalse(ClipBudget.clipsFit(loyalists, 192 * mb))
    assertEquals(setOf(0), ClipBudget.wholeFiles(listOf(loyalists), chapters(0, 94), 192 * mb))
  }

  @Test fun aLongM4bClipsInALargeHeap() {
    assertTrue(ClipBudget.clipsFit(loyalists, 576 * mb))
    assertTrue(ClipBudget.wholeFiles(listOf(loyalists), chapters(0, 94), 576 * mb).isEmpty())
  }

  @Test fun theEstimateCoversTheMeasuredTable() {
    // Measured on the emulator: ~119 MB of Java heap per extractor for Loyalists' 3.65 M samples.
    val bytes = ClipBudget.tableBytes(loyalists)
    assertTrue(bytes in 119 * mb..160 * mb)
  }

  @Test fun anOrdinaryM4bKeepsItsClips() {
    assertTrue(ClipBudget.clipsFit(track("A/Book/book.m4b", 9.0), 192 * mb))
  }

  @Test fun aDownloadedM4bIsCountedByItsFileName() {
    val local = track("A/Book/book.m4b", 30.0, url = "file:///data/user/0/app/files/downloads/x/0.m4b")
    assertFalse(ClipBudget.clipsFit(local, 192 * mb))
  }

  @Test fun containersWithoutASampleTableAlwaysClip() {
    for (ext in listOf("mp3", "flac", "ogg", "opus", "mka")) {
      assertEquals(ext, 0L, ClipBudget.tableBytes(track("A/Book/book.$ext", 40.0)))
    }
    val localMp3 = track("A/Book/book.mp3", 40.0, url = "file:///data/x/0.mp3")
    assertTrue(ClipBudget.clipsFit(localMp3, 192 * mb))
  }

  @Test fun anUnnamedContainerIsCountedAsMp4() {
    val t = TrackSpec("opaque", "http://host/stream/42", "Book", null, null, null, 30 * 3600.0)
    assertFalse(ClipBudget.clipsFit(t, 192 * mb))
  }

  @Test fun anUnknownDurationWithNoClipsCountsNothing() {
    assertEquals(0L, ClipBudget.tableBytes(track("A/Book/book.m4b", 0.0)))
  }

  @Test fun anUnknownDurationIsAsLongAsTheClipsReach() {
    // Loyalists with no duration from the server: its 94 chapters reach 23.5 h into the file,
    // the last one "to end" (endInFile 0) as `buildChapterClips` sends it.
    val unknown = loyalists.copy(duration = 0.0)
    val clips = List(94) { ClipSpec(0, it * 901.0, if (it == 93) 0.0 else (it + 1) * 901.0, "Chapter ${it + 1}") }
    assertEquals(setOf(0), ClipBudget.wholeFiles(listOf(unknown), clips, 192 * mb))
    // Two 24 h chapters, the last "to end": 48 h, not the 24 h its start says.
    val two = listOf(ClipSpec(0, 0.0, 86_400.0, "One"), ClipSpec(0, 86_400.0, 0.0, "Two"))
    assertEquals(setOf(0), ClipBudget.wholeFiles(listOf(unknown), two, 400 * mb))
    // A short book of unknown length keeps its clips.
    val short = track("A/Book/book.m4b", 0.0)
    assertTrue(ClipBudget.wholeFiles(listOf(short), chapters(0, 6), 192 * mb).isEmpty())
  }

  @Test fun onlyTheHeavyFileOfAMultiFileBookPlaysWhole() {
    val tracks = listOf(track("A/Book/part 1.m4b", 2.0), track("A/Book/part 2.m4b", 25.0))
    val clips = chapters(0, 10) + chapters(1, 60)
    assertEquals(setOf(1), ClipBudget.wholeFiles(tracks, clips, 192 * mb))
  }

  @Test fun aBadPercentEscapeDoesNotThrow() {
    val t = track("A/Book/book.mp3", 40.0, url = "http://host/stream?path=A%2Fbook%ZZ.mp3")
    assertEquals(0L, ClipBudget.tableBytes(t))
  }
}
