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
}
