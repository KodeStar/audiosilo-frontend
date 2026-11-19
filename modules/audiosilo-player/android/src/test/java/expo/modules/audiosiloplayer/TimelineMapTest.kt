package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineMapTest {
  private fun clip(file: Int, start: Double, end: Double, dur: Double = 3600.0) =
    TimelineMap.Entry(file, start, end, dur, clip = true)

  // Two files: file 0 has chapters [0,100) [100,250) [260,end); file 1 is one chapter.
  private val clips = TimelineMap(
    listOf(clip(0, 0.0, 100.0), clip(0, 100.0, 250.0), clip(0, 260.0, 0.0), clip(1, 0.0, 0.0, 1800.0)),
  )

  @Test fun mapsAPositionInsideAClip() {
    assertEquals(Pair(1, 50_000L), clips.fileToItem(0, 150.0))
    assertEquals(Pair(3, 12_500L), clips.fileToItem(1, 12.5))
  }

  @Test fun openEndedClipRunsToTheFileEnd() {
    assertEquals(Pair(2, 3_000_000L), clips.fileToItem(0, 3260.0))
  }

  @Test fun gapSnapsToTheLatestClipStartingBefore() {
    // 255 s is in the gap between [100,250) and [260,...): the candidate is clip 1, clamped to
    // its clipped end (never measured against the file's first clip).
    assertEquals(Pair(1, 150_000L), clips.fileToItem(0, 255.0))
  }

  @Test fun beforeTheFirstClipClampsToItsStart() {
    val late = TimelineMap(listOf(clip(0, 30.0, 100.0)))
    assertEquals(Pair(0, 0L), late.fileToItem(0, 5.0))
  }

  @Test fun itemToFileAddsTheClipStart() {
    assertEquals(Pair(0, 112.5), clips.itemToFile(1, 12_500L))
    assertEquals(Pair(1, 2.0), clips.itemToFile(3, 2_000L))
    assertEquals(1800.0, clips.fileDurationAt(3), 0.0)
  }

  @Test fun wholeFileItemsAreIdentity() {
    val files = TimelineMap(
      listOf(TimelineMap.Entry(0, 0.0, 0.0, 600.0, false), TimelineMap.Entry(1, 0.0, 0.0, 700.0, false)),
    )
    assertFalse(files.clipped)
    assertTrue(clips.clipped)
    assertEquals(Pair(1, 42_000L), files.fileToItem(1, 42.0))
    assertEquals(Pair(1, 42.0), files.itemToFile(1, 42_000L))
  }

  @Test fun unknownItemFallsBackToIdentity() {
    assertEquals(Pair(7, 1.5), TimelineMap(emptyList()).itemToFile(7, 1_500L))
  }

  // fe#351: Media3 reports a new item's place before its item change, so a tick names its file.
  @Test fun aWholeFileTickNamesItsFileWithTheEnginesOwnLength() {
    val files = TimelineMap(
      listOf(TimelineMap.Entry(0, 0.0, 0.0, 900.0, false), TimelineMap.Entry(1, 0.0, 0.0, 900.0, false)),
    )
    // A VBR file the engine measures short (600 s against the server's 900 s): its measure.
    assertEquals(TimelineMap.Sample(1, 600.0, 600.0), files.sample(1, 600_000L, 600_000L))
    // Not measured yet: the server's.
    assertEquals(TimelineMap.Sample(1, 2.5, 900.0), files.sample(1, 2_500L, Long.MIN_VALUE + 1))
  }

  @Test fun aClipInsideItsFileTicksWithTheFilesLength() {
    // Item 1 is the second of file 0's chapters, [100,250): it says nothing of the file's end.
    assertEquals(TimelineMap.Sample(0, 112.5, 3600.0), clips.sample(1, 12_500L, 150_000L))
    // Not measured yet: the server's, for any clip.
    assertEquals(TimelineMap.Sample(1, 2.0, 1800.0), clips.sample(3, 2_000L, Long.MIN_VALUE + 1))
  }

  // fe#351: a book with a chapter per file plays as clips, and told with the server's length
  // its ticks never showed the store a file the engine measures short.
  @Test fun aClipToItsFilesEndTicksWithTheEnginesOwnLength() {
    // Item 3 is file 1's only chapter: a VBR file the engine measures at 600 s, not 1800 s.
    assertEquals(TimelineMap.Sample(1, 600.0, 600.0), clips.sample(3, 600_000L, 600_000L))
    // Item 2 is file 0's last chapter, from 260 s: 3340 s of it reach the file's end at 3600 s.
    assertEquals(TimelineMap.Sample(0, 262.0, 3600.0), clips.sample(2, 2_000L, 3_340_000L))
  }

  @Test fun aClipCutShortOfItsBoundsTicksWithTheEnginesOwnLength() {
    // The engine ends file 0 at 180 s, inside [100,250): the clip is 80 s long, not 150 s.
    assertEquals(TimelineMap.Sample(0, 180.0, 180.0), clips.sample(1, 80_000L, 80_000L))
    // Off by a rounding only: its bounds stand, the file's length the server's.
    assertEquals(TimelineMap.Sample(0, 101.0, 3600.0), clips.sample(1, 1_000L, 149_800L))
  }

  @Test fun aWholeFileItemAmongClipsTicksWithItsOwnLength() {
    // A file too long to clip plays whole among another file's clips ([ClipBudget]).
    val mixed = TimelineMap(listOf(TimelineMap.Entry(0, 0.0, 0.0, 900.0, false), clip(1, 0.0, 0.0, 1800.0)))
    assertEquals(TimelineMap.Sample(0, 5.0, 600.0), mixed.sample(0, 5_000L, 600_000L))
  }
}
