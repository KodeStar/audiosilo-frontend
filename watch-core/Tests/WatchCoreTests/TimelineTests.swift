// Ported from src/playback/book-queue.test.ts.
import XCTest

@testable import WatchCore

func makeBook(relPath: String = "x", duration: Double = 0, size: Int64 = 0, files: [BookFile]? = nil,
              chapters: [Chapter]? = nil) -> Book
{
  Book(libraryId: 2, relPath: relPath, title: "T", author: "A", narrator: "", duration: duration, size: size,
       files: files, chapters: chapters)
}

func ch(index: Int = 0, title: String = "ch", fileIndex: Int = 0, filePath: String = "f", start: Double = 0,
        end: Double = 0, bookOffset: Double = 0) -> Chapter
{
  Chapter(index: index, title: title, fileIndex: fileIndex, filePath: filePath, start: start, end: end,
          bookOffset: bookOffset)
}

func file(_ path: String, seq: Int, duration: Double, size: Int64 = 0) -> BookFile {
  BookFile(relPath: path, seq: seq, duration: duration, format: "mp3", size: size)
}

func spec(_ path: String, _ duration: Double = 0) -> FileSpec { FileSpec(path: path, duration: duration, size: 0) }

final class BookFileSpecsTests: XCTestCase {
  func testPrefersTheExplicitFileListSortedBySeq() {
    let book = makeBook(relPath: "A/Book", files: [
      file("A/Book/02.mp3", seq: 2, duration: 100, size: 10), file("A/Book/01.mp3", seq: 1, duration: 60, size: 5),
    ])
    XCTAssertEqual(bookFileSpecs(book).map(\.path), ["A/Book/01.mp3", "A/Book/02.mp3"])
  }

  func testFallsBackToTheDistinctFilesReferencedByChapters() {
    let book = makeBook(files: [], chapters: [
      ch(index: 0, filePath: "p1.mp3", end: 30), ch(index: 1, fileIndex: 1, filePath: "p2.mp3", end: 50),
    ])
    XCTAssertEqual(bookFileSpecs(book), [spec("p1.mp3", 30), spec("p2.mp3", 50)])
  }

  func testFallsBackToTheBookPathItself() {
    XCTAssertEqual(bookFileSpecs(makeBook(relPath: "solo.m4b", duration: 42, size: 7)),
                   [FileSpec(path: "solo.m4b", duration: 42, size: 7)])
  }

  func testPrefersTheChaptersResponseFileList() {
    let book = makeBook(relPath: "A", files: [file("old.mp3", seq: 1, duration: 10)])
    let data = ChaptersResponse(duration: 20, files: [file("new.mp3", seq: 1, duration: 20)], chapters: [])
    XCTAssertEqual(bookFileSpecs(book, data).map(\.path), ["new.mp3"])
  }
}

final class TimelineBuildTests: XCTestCase {
  func testLaysMultipleFilesOntoOneTimeline() {
    let t = Timeline(book: makeBook(relPath: "A/Book", files: [
      file("A/Book/01.mp3", seq: 1, duration: 60), file("A/Book/02.mp3", seq: 2, duration: 100),
    ]))
    XCTAssertEqual(t.files.map(\.path), ["A/Book/01.mp3", "A/Book/02.mp3"])
    XCTAssertEqual(t.offsets, [0, 60])
    XCTAssertEqual(t.total, 160)
  }

  func testRecomputesEachChapterOffsetFromTrackOffsets() {
    let data = ChaptersResponse(duration: 200, files: [file("A/single.m4b", seq: 1, duration: 200)], chapters: [
      ch(index: 0, filePath: "A/single.m4b", start: 0, end: 100, bookOffset: 0),
      ch(index: 1, filePath: "A/single.m4b", start: 100, end: 200, bookOffset: 0),
    ])
    let t = Timeline(book: makeBook(relPath: "A/single.m4b", duration: 200), chapters: data)
    XCTAssertEqual(t.offsets, [0])
    XCTAssertEqual(t.chapters[1].bookOffset, 100)
    XCTAssertEqual(t.total, 200)
  }

  func testMapsChapterOffsetsByFilePathNotFileIndex() {
    let t = Timeline(book: makeBook(relPath: "A/Book", files: [], chapters: [
      ch(index: 0, fileIndex: 1, filePath: "p2.mp3", start: 5, end: 50),
      ch(index: 1, fileIndex: 0, filePath: "p1.mp3", start: 0, end: 30),
    ]))
    XCTAssertEqual(t.files.map(\.path), ["p2.mp3", "p1.mp3"])
    XCTAssertEqual(t.offsets, [0, 50])
    XCTAssertEqual(t.chapters[0].bookOffset, 5)
    XCTAssertEqual(t.chapters[1].bookOffset, 50)
  }

  func testSynthesizesChaptersForALongChapterlessSingleFile() {
    let t = Timeline(book: makeBook(relPath: "big.mp3", duration: 5400))
    XCTAssertEqual(t.offsets, [0])
    XCTAssertEqual(t.chapters.map(\.bookOffset), [0, 1800, 3600])
    XCTAssertTrue(t.chapters.allSatisfy { $0.filePath == "big.mp3" })
    XCTAssertEqual(t.total, 5400)
    XCTAssertTrue(t.syntheticChapters)
  }

  func testDoesNotSynthesizeForAShortSingleFile() {
    let t = Timeline(book: makeBook(relPath: "small.mp3", duration: 600))
    XCTAssertEqual(t.chapters, [])
    XCTAssertFalse(t.syntheticChapters)
  }

  func testSynthesizesOverALoneWholeBookChapter() {
    let data = ChaptersResponse(duration: 5400, files: [file("A/single.m4b", seq: 1, duration: 5400)],
                                chapters: [ch(filePath: "A/single.m4b", start: 0, end: 5400)])
    let t = Timeline(book: makeBook(relPath: "A/single.m4b", duration: 5400), chapters: data)
    XCTAssertEqual(t.chapters.count, 3)
    XCTAssertTrue(t.syntheticChapters)
  }

  func testLeavesARealMultiChapterBookUntouched() {
    let data = ChaptersResponse(duration: 5400, files: [file("A/single.m4b", seq: 1, duration: 5400)], chapters: [
      ch(index: 0, title: "One", filePath: "A/single.m4b", start: 0, end: 1800),
      ch(index: 1, title: "Two", filePath: "A/single.m4b", start: 1800, end: 3600),
      ch(index: 2, title: "Three", filePath: "A/single.m4b", start: 3600, end: 5400),
    ])
    let t = Timeline(book: makeBook(relPath: "A/single.m4b", duration: 5400), chapters: data)
    XCTAssertEqual(t.chapters.map(\.title), ["One", "Two", "Three"])
    XCTAssertFalse(t.syntheticChapters)
  }

  func testDoesNotSynthesizeForAMultiFileBook() {
    let t = Timeline(book: makeBook(relPath: "A/Book", files: [
      file("A/Book/01.mp3", seq: 1, duration: 1800), file("A/Book/02.mp3", seq: 2, duration: 1800),
    ]))
    XCTAssertEqual(t.chapters, [])
    XCTAssertEqual(t.offsets, [0, 1800])
    XCTAssertFalse(t.syntheticChapters)
  }

  func testHonorsACustomInterval() {
    let t = Timeline(book: makeBook(relPath: "big.mp3", duration: 5400), virtualChapterInterval: 900)
    XCTAssertEqual(t.chapters.map(\.bookOffset), [0, 900, 1800, 2700, 3600, 4500])
  }

  // Sync v2's event duration.
  func testAudioIsTheFilesSummedThoughAChapterOverhangs() {
    let t = Timeline(book: makeBook(relPath: "A/Book", files: [
      file("A/Book/01.mp3", seq: 1, duration: 60), file("A/Book/02.mp3", seq: 2, duration: 100),
    ], chapters: [ch(fileIndex: 1, filePath: "A/Book/02.mp3", start: 0, end: 140)]))
    XCTAssertEqual(t.total, 200)
    XCTAssertEqual(t.audio, 160)
  }

  func testAudioIsTheSingleFileDurationWithoutAFileList() {
    XCTAssertEqual(Timeline(book: makeBook(relPath: "A/one.m4b", duration: 300)).audio, 300)
  }

  func testAudioIsUnknownWhenEstimatedOrAFileHasNoLength() {
    let fromChapters = makeBook(relPath: "A/Book", chapters: [ch(filePath: "p1.mp3", start: 0, end: 50)])
    XCTAssertEqual(Timeline(book: fromChapters).audio, 0)
    let unknown = makeBook(relPath: "A/Book", files: [
      file("A/Book/01.mp3", seq: 1, duration: 60), file("A/Book/02.mp3", seq: 2, duration: 0),
    ])
    XCTAssertEqual(Timeline(book: unknown).audio, 0)
  }
}

final class SynthesizeAndTimelineMathTests: XCTestCase {
  func testSplitsALongFileIntoEvenBlocks() {
    let out = synthesizeChapters("big.mp3", 5400, 1800)
    XCTAssertEqual(out.map(\.start), [0, 1800, 3600])
    XCTAssertEqual(out.map(\.end), [1800, 3600, 5400])
    XCTAssertEqual(out.map(\.bookOffset), [0, 1800, 3600])
    XCTAssertEqual(out.map(\.index), [0, 1, 2])
    XCTAssertTrue(out.allSatisfy { $0.title == "" && $0.fileIndex == 0 && $0.filePath == "big.mp3" })
  }

  func testClampsTheFinalBlock() {
    let out = synthesizeChapters("big.mp3", 5401, 1800)
    XCTAssertEqual(out.count, 4)
    XCTAssertEqual(out[3].start, 5400)
    XCTAssertEqual(out[3].end, 5401)
  }

  func testNoEmptyTrailingChapterOnAnExactMultiple() {
    let out = synthesizeChapters("big.mp3", 3600, 1800)
    XCTAssertEqual(out.count, 2)
    XCTAssertEqual(out[1].end, 3600)
  }

  func testNothingBelowTheThreshold() {
    XCTAssertEqual(synthesizeChapters("big.mp3", 2000, 1800), [])
    XCTAssertEqual(synthesizeChapters("big.mp3", 0, 1800), [])
    XCTAssertEqual(synthesizeChapters("big.mp3", 5400).count, 3)
  }

  func testLocateAndToBookPositionRoundTrip() {
    let offsets: [Double] = [0, 60, 160]
    XCTAssertTrue(locateIn(offsets, 0) == (0, 0))
    XCTAssertTrue(locateIn(offsets, 70) == (1, 10))
    XCTAssertTrue(locateIn(offsets, 500) == (2, 340))
    XCTAssertEqual(toBookPosition(offsets, 1, 10), 70)
  }

  func testChapterAtClampsBelowTheFirst() {
    let chapters = [ch(index: 0, bookOffset: 0), ch(index: 1, bookOffset: 50)]
    XCTAssertEqual(ChapterNav.index(chapters, 75), 1)
    XCTAssertEqual(ChapterNav.index(chapters, -5), 0)
    XCTAssertNil(ChapterNav.index([], 10))
  }

  func testSpanEndCarriesTheFileAndRefusesNaN() {
    let t = Timeline(book: makeBook(relPath: "A/Book", files: [
      file("A/Book/01.mp3", seq: 1, duration: 60), file("A/Book/02.mp3", seq: 2, duration: 100),
    ]))
    XCTAssertEqual(t.spanEnd(index: 1, positionInTrack: 10), SpanEnd(pos: 70, file: "A/Book/02.mp3", filePos: 10))
    XCTAssertNil(t.spanEnd(index: 0, positionInTrack: .nan))
  }

  // store-listening.test.ts "resume by file (fe#188)".
  func testResumesInTheSavedFileThoughTheOrderMoved() {
    let t = Timeline(book: makeBook(relPath: "A/Book", files: [
      file("A/Book/01.mp3", seq: 1, duration: 60), file("A/Book/02.mp3", seq: 2, duration: 100),
    ]))
    XCTAssertTrue(t.resumePlace(position: 5, file: "A/Book/02.mp3", filePos: 30) == (1, 30))
    XCTAssertTrue(t.resumePlace(position: 70, file: "gone.mp3", filePos: 30) == (1, 10))
    XCTAssertTrue(t.resumePlace(position: 70, file: "A/Book/01.mp3", filePos: 500) == (0, 60))
  }
}

final class NextChapterEndTests: XCTestCase {
  let chapters = [
    ch(index: 0, start: 0, end: 60, bookOffset: 0), ch(index: 1, start: 60, end: 200, bookOffset: 60),
    ch(index: 2, start: 200, end: 320, bookOffset: 200),
  ]

  func testTheFirstEndFurtherThanMinSeconds() {
    let out = nextChapterEnd(chapters, 0, rate: 1, minSeconds: 30)
    XCTAssertEqual(out?.chapter.index, 0)
    XCTAssertEqual(out?.endPosition, 60)
    XCTAssertEqual(out?.untilEnd, 60)
  }

  func testSkipsAnEndTooSoon() {
    XCTAssertEqual(nextChapterEnd(chapters, 40, rate: 1, minSeconds: 30)?.endPosition, 200)
  }

  func testMeasuresInWallClock() {
    XCTAssertEqual(nextChapterEnd(chapters, 20, rate: 1, minSeconds: 30)?.chapter.index, 0)
    XCTAssertEqual(nextChapterEnd(chapters, 20, rate: 2, minSeconds: 30)?.chapter.index, 1)
  }

  func testNilWhenNoneIsFarEnough() {
    XCTAssertNil(nextChapterEnd(chapters, 300, rate: 1, minSeconds: 30))
    XCTAssertNil(nextChapterEnd([], 0, rate: 1, minSeconds: 30))
  }

  func testTakesTheNearestQualifyingEnd() {
    let jumbled = [
      ch(index: 5, start: 0, end: 14_400, bookOffset: 0), ch(index: 1, start: 60, end: 200, bookOffset: 60),
      ch(index: 2, start: 200, end: 320, bookOffset: 200),
    ]
    let out = nextChapterEnd(jumbled, 40, rate: 1, minSeconds: 30)
    XCTAssertEqual(out?.endPosition, 200)
    XCTAssertEqual(out?.untilEnd, 160)
    let near = [ch(index: 2, start: 200, end: 320, bookOffset: 200), ch(index: 0, start: 0, end: 60, bookOffset: 0)]
    XCTAssertEqual(nextChapterEnd(near, 40, rate: 1, minSeconds: 30)?.endPosition, 320)
  }

  func testBadMetadataIsAZeroLengthChapter() {
    let broken = [ch(index: 0, start: 200, end: 50, bookOffset: 100)]
    XCTAssertEqual(chapterEndPosition(broken[0]), 100)
    XCTAssertEqual(nextChapterEnd(broken, 0, rate: 1, minSeconds: 30)?.endPosition, 100)
  }
}
