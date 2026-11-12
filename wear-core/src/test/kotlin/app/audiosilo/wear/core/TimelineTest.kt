// Ported from watch-core/Tests/WatchCoreTests/TimelineTests.swift (itself book-queue.test.ts).
package app.audiosilo.wear.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

fun makeBook(
  relPath: String = "x",
  duration: Double = 0.0,
  size: Long = 0,
  files: List<BookFile>? = null,
  chapters: List<Chapter>? = null,
) = Book(2, relPath, "T", "A", "", duration, size, files, chapters)

fun ch(
  index: Int = 0,
  title: String = "ch",
  fileIndex: Int = 0,
  filePath: String = "f",
  start: Double = 0.0,
  end: Double = 0.0,
  bookOffset: Double = 0.0,
) = Chapter(index, title, fileIndex, filePath, start, end, bookOffset)

fun file(path: String, seq: Int, duration: Double, size: Long = 0) =
  BookFile(path, seq, duration, "mp3", size)

fun spec(path: String, duration: Double = 0.0) = FileSpec(path, duration, 0)

class BookFileSpecsTest {
  @Test
  fun prefersTheExplicitFileListSortedBySeq() {
    val book =
      makeBook(
        relPath = "A/Book",
        files = listOf(file("A/Book/02.mp3", 2, 100.0, 10), file("A/Book/01.mp3", 1, 60.0, 5)),
      )
    assertEquals(listOf("A/Book/01.mp3", "A/Book/02.mp3"), bookFileSpecs(book).map { it.path })
  }

  @Test
  fun fallsBackToTheDistinctFilesReferencedByChapters() {
    val book =
      makeBook(
        files = emptyList(),
        chapters =
          listOf(
            ch(index = 0, filePath = "p1.mp3", end = 30.0),
            ch(index = 1, fileIndex = 1, filePath = "p2.mp3", end = 50.0),
          ),
      )
    assertEquals(listOf(spec("p1.mp3", 30.0), spec("p2.mp3", 50.0)), bookFileSpecs(book))
  }

  @Test
  fun fallsBackToTheBookPathItself() {
    assertEquals(
      listOf(FileSpec("solo.m4b", 42.0, 7)),
      bookFileSpecs(makeBook(relPath = "solo.m4b", duration = 42.0, size = 7)),
    )
  }

  @Test
  fun prefersTheChaptersResponseFileList() {
    val book = makeBook(relPath = "A", files = listOf(file("old.mp3", 1, 10.0)))
    val data = ChaptersResponse(20.0, listOf(file("new.mp3", 1, 20.0)), emptyList())
    assertEquals(listOf("new.mp3"), bookFileSpecs(book, data).map { it.path })
  }
}

class TimelineBuildTest {
  @Test
  fun laysMultipleFilesOntoOneTimeline() {
    val t =
      Timeline.of(
        makeBook(
          relPath = "A/Book",
          files = listOf(file("A/Book/01.mp3", 1, 60.0), file("A/Book/02.mp3", 2, 100.0)),
        )
      )
    assertEquals(listOf("A/Book/01.mp3", "A/Book/02.mp3"), t.files.map { it.path })
    assertEquals(listOf(0.0, 60.0), t.offsets)
    assertEquals(160.0, t.total, 0.0)
  }

  @Test
  fun recomputesEachChapterOffsetFromTrackOffsets() {
    val data =
      ChaptersResponse(
        200.0,
        listOf(file("A/single.m4b", 1, 200.0)),
        listOf(
          ch(index = 0, filePath = "A/single.m4b", start = 0.0, end = 100.0, bookOffset = 0.0),
          ch(index = 1, filePath = "A/single.m4b", start = 100.0, end = 200.0, bookOffset = 0.0),
        ),
      )
    val t = Timeline.of(makeBook(relPath = "A/single.m4b", duration = 200.0), data)
    assertEquals(listOf(0.0), t.offsets)
    assertEquals(100.0, t.chapters[1].bookOffset, 0.0)
    assertEquals(200.0, t.total, 0.0)
  }

  @Test
  fun mapsChapterOffsetsByFilePathNotFileIndex() {
    val t =
      Timeline.of(
        makeBook(
          relPath = "A/Book",
          files = emptyList(),
          chapters =
            listOf(
              ch(index = 0, fileIndex = 1, filePath = "p2.mp3", start = 5.0, end = 50.0),
              ch(index = 1, fileIndex = 0, filePath = "p1.mp3", start = 0.0, end = 30.0),
            ),
        )
      )
    assertEquals(listOf("p2.mp3", "p1.mp3"), t.files.map { it.path })
    assertEquals(listOf(0.0, 50.0), t.offsets)
    assertEquals(5.0, t.chapters[0].bookOffset, 0.0)
    assertEquals(50.0, t.chapters[1].bookOffset, 0.0)
  }

  @Test
  fun synthesizesChaptersForALongChapterlessSingleFile() {
    val t = Timeline.of(makeBook(relPath = "big.mp3", duration = 5400.0))
    assertEquals(listOf(0.0), t.offsets)
    assertEquals(listOf(0.0, 1800.0, 3600.0), t.chapters.map { it.bookOffset })
    assertTrue(t.chapters.all { it.filePath == "big.mp3" })
    assertEquals(5400.0, t.total, 0.0)
    assertTrue(t.syntheticChapters)
  }

  @Test
  fun doesNotSynthesizeForAShortSingleFile() {
    val t = Timeline.of(makeBook(relPath = "small.mp3", duration = 600.0))
    assertEquals(emptyList<Chapter>(), t.chapters)
    assertFalse(t.syntheticChapters)
  }

  @Test
  fun synthesizesOverALoneWholeBookChapter() {
    val data =
      ChaptersResponse(
        5400.0,
        listOf(file("A/single.m4b", 1, 5400.0)),
        listOf(ch(filePath = "A/single.m4b", start = 0.0, end = 5400.0)),
      )
    val t = Timeline.of(makeBook(relPath = "A/single.m4b", duration = 5400.0), data)
    assertEquals(3, t.chapters.size)
    assertTrue(t.syntheticChapters)
  }

  @Test
  fun leavesARealMultiChapterBookUntouched() {
    val data =
      ChaptersResponse(
        5400.0,
        listOf(file("A/single.m4b", 1, 5400.0)),
        listOf(
          ch(index = 0, title = "One", filePath = "A/single.m4b", start = 0.0, end = 1800.0),
          ch(index = 1, title = "Two", filePath = "A/single.m4b", start = 1800.0, end = 3600.0),
          ch(index = 2, title = "Three", filePath = "A/single.m4b", start = 3600.0, end = 5400.0),
        ),
      )
    val t = Timeline.of(makeBook(relPath = "A/single.m4b", duration = 5400.0), data)
    assertEquals(listOf("One", "Two", "Three"), t.chapters.map { it.title })
    assertFalse(t.syntheticChapters)
  }

  @Test
  fun doesNotSynthesizeForAMultiFileBook() {
    val t =
      Timeline.of(
        makeBook(
          relPath = "A/Book",
          files = listOf(file("A/Book/01.mp3", 1, 1800.0), file("A/Book/02.mp3", 2, 1800.0)),
        )
      )
    assertEquals(emptyList<Chapter>(), t.chapters)
    assertEquals(listOf(0.0, 1800.0), t.offsets)
    assertFalse(t.syntheticChapters)
  }

  @Test
  fun honorsACustomInterval() {
    val t = Timeline.of(makeBook(relPath = "big.mp3", duration = 5400.0), virtualChapterInterval = 900.0)
    assertEquals(
      listOf(0.0, 900.0, 1800.0, 2700.0, 3600.0, 4500.0),
      t.chapters.map { it.bookOffset },
    )
  }

  // Sync v2's event duration.
  @Test
  fun audioIsTheFilesSummedThoughAChapterOverhangs() {
    val t =
      Timeline.of(
        makeBook(
          relPath = "A/Book",
          files = listOf(file("A/Book/01.mp3", 1, 60.0), file("A/Book/02.mp3", 2, 100.0)),
          chapters = listOf(ch(fileIndex = 1, filePath = "A/Book/02.mp3", start = 0.0, end = 140.0)),
        )
      )
    assertEquals(200.0, t.total, 0.0)
    assertEquals(160.0, t.audio, 0.0)
  }

  @Test
  fun audioIsTheSingleFileDurationWithoutAFileList() {
    assertEquals(300.0, Timeline.of(makeBook(relPath = "A/one.m4b", duration = 300.0)).audio, 0.0)
  }

  @Test
  fun audioIsUnknownWhenEstimatedOrAFileHasNoLength() {
    val fromChapters =
      makeBook(relPath = "A/Book", chapters = listOf(ch(filePath = "p1.mp3", start = 0.0, end = 50.0)))
    assertEquals(0.0, Timeline.of(fromChapters).audio, 0.0)
    val unknown =
      makeBook(
        relPath = "A/Book",
        files = listOf(file("A/Book/01.mp3", 1, 60.0), file("A/Book/02.mp3", 2, 0.0)),
      )
    assertEquals(0.0, Timeline.of(unknown).audio, 0.0)
  }
}

class SynthesizeAndTimelineMathTest {
  @Test
  fun splitsALongFileIntoEvenBlocks() {
    val out = synthesizeChapters("big.mp3", 5400.0, 1800.0)
    assertEquals(listOf(0.0, 1800.0, 3600.0), out.map { it.start })
    assertEquals(listOf(1800.0, 3600.0, 5400.0), out.map { it.end })
    assertEquals(listOf(0.0, 1800.0, 3600.0), out.map { it.bookOffset })
    assertEquals(listOf(0, 1, 2), out.map { it.index })
    assertTrue(out.all { it.title == "" && it.fileIndex == 0 && it.filePath == "big.mp3" })
  }

  @Test
  fun clampsTheFinalBlock() {
    val out = synthesizeChapters("big.mp3", 5401.0, 1800.0)
    assertEquals(4, out.size)
    assertEquals(5400.0, out[3].start, 0.0)
    assertEquals(5401.0, out[3].end, 0.0)
  }

  @Test
  fun noEmptyTrailingChapterOnAnExactMultiple() {
    val out = synthesizeChapters("big.mp3", 3600.0, 1800.0)
    assertEquals(2, out.size)
    assertEquals(3600.0, out[1].end, 0.0)
  }

  @Test
  fun nothingBelowTheThreshold() {
    assertEquals(emptyList<Chapter>(), synthesizeChapters("big.mp3", 2000.0, 1800.0))
    assertEquals(emptyList<Chapter>(), synthesizeChapters("big.mp3", 0.0, 1800.0))
    assertEquals(3, synthesizeChapters("big.mp3", 5400.0).size)
  }

  @Test
  fun locateAndToBookPositionRoundTrip() {
    val offsets = listOf(0.0, 60.0, 160.0)
    assertEquals(Located(0, 0.0), locateIn(offsets, 0.0))
    assertEquals(Located(1, 10.0), locateIn(offsets, 70.0))
    assertEquals(Located(2, 340.0), locateIn(offsets, 500.0))
    assertEquals(70.0, toBookPosition(offsets, 1, 10.0), 0.0)
  }

  @Test
  fun theChapterIndexClampsBelowTheFirst() {
    val chapters = listOf(ch(index = 0, bookOffset = 0.0), ch(index = 1, bookOffset = 50.0))
    assertEquals(1, ChapterNav.index(chapters, 75.0))
    assertEquals(0, ChapterNav.index(chapters, -5.0))
    assertNull(ChapterNav.index(emptyList(), 10.0))
  }

  @Test
  fun spanEndCarriesTheFileAndRefusesNaN() {
    val t =
      Timeline.of(
        makeBook(
          relPath = "A/Book",
          files = listOf(file("A/Book/01.mp3", 1, 60.0), file("A/Book/02.mp3", 2, 100.0)),
        )
      )
    assertEquals(SpanEnd(70.0, "A/Book/02.mp3", 10.0), t.spanEnd(1, 10.0))
    assertNull(t.spanEnd(0, Double.NaN))
  }

  // store-listening.test.ts "resume by file (fe#188)".
  @Test
  fun resumesInTheSavedFileThoughTheOrderMoved() {
    val t =
      Timeline.of(
        makeBook(
          relPath = "A/Book",
          files = listOf(file("A/Book/01.mp3", 1, 60.0), file("A/Book/02.mp3", 2, 100.0)),
        )
      )
    assertEquals(Located(1, 30.0), t.resumePlace(5.0, "A/Book/02.mp3", 30.0))
    assertEquals(Located(1, 10.0), t.resumePlace(70.0, "gone.mp3", 30.0))
    assertEquals(Located(0, 60.0), t.resumePlace(70.0, "A/Book/01.mp3", 500.0))
  }
}

class NextChapterEndTest {
  private val chapters =
    listOf(
      ch(index = 0, start = 0.0, end = 60.0, bookOffset = 0.0),
      ch(index = 1, start = 60.0, end = 200.0, bookOffset = 60.0),
      ch(index = 2, start = 200.0, end = 320.0, bookOffset = 200.0),
    )

  @Test
  fun theFirstEndFurtherThanMinSeconds() {
    val out = nextChapterEnd(chapters, 0.0, 1.0, 30.0)
    assertEquals(0, out?.chapter?.index)
    assertEquals(60.0, out?.endPosition)
    assertEquals(60.0, out?.untilEnd)
  }

  @Test
  fun skipsAnEndTooSoon() {
    assertEquals(200.0, nextChapterEnd(chapters, 40.0, 1.0, 30.0)?.endPosition)
  }

  @Test
  fun measuresInWallClock() {
    assertEquals(0, nextChapterEnd(chapters, 20.0, 1.0, 30.0)?.chapter?.index)
    assertEquals(1, nextChapterEnd(chapters, 20.0, 2.0, 30.0)?.chapter?.index)
  }

  @Test
  fun nullWhenNoneIsFarEnough() {
    assertNull(nextChapterEnd(chapters, 300.0, 1.0, 30.0))
    assertNull(nextChapterEnd(emptyList(), 0.0, 1.0, 30.0))
  }

  @Test
  fun takesTheNearestQualifyingEnd() {
    val jumbled =
      listOf(
        ch(index = 5, start = 0.0, end = 14_400.0, bookOffset = 0.0),
        ch(index = 1, start = 60.0, end = 200.0, bookOffset = 60.0),
        ch(index = 2, start = 200.0, end = 320.0, bookOffset = 200.0),
      )
    val out = nextChapterEnd(jumbled, 40.0, 1.0, 30.0)
    assertEquals(200.0, out?.endPosition)
    assertEquals(160.0, out?.untilEnd)
    val near =
      listOf(
        ch(index = 2, start = 200.0, end = 320.0, bookOffset = 200.0),
        ch(index = 0, start = 0.0, end = 60.0, bookOffset = 0.0),
      )
    assertEquals(320.0, nextChapterEnd(near, 40.0, 1.0, 30.0)?.endPosition)
  }

  @Test
  fun badMetadataIsAZeroLengthChapter() {
    val broken = listOf(ch(index = 0, start = 200.0, end = 50.0, bookOffset = 100.0))
    assertEquals(100.0, chapterEndPosition(broken[0]), 0.0)
    assertEquals(100.0, nextChapterEnd(broken, 0.0, 1.0, 30.0)?.endPosition)
  }
}
