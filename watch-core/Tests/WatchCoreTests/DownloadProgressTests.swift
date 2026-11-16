import XCTest
@testable import WatchCore

final class DownloadProgressTests: XCTestCase {
  private func file(_ duration: Double, done: Bool = false, _ fraction: Double = 0) -> DownloadProgress.File {
    DownloadProgress.File(duration: duration, done: done, fraction: fraction)
  }

  func testWeighsTheFilesByAudioTime() {
    // One hour landed of four: a quarter, whatever the files' sizes.
    XCTAssertEqual(DownloadProgress.percent([file(3600, done: true), file(10800)]), 25)
    // Half of the three-hour file in flight on top.
    XCTAssertEqual(DownloadProgress.percent([file(3600, done: true), file(10800, 0.5)]), 62)
    XCTAssertEqual(DownloadProgress.percent([file(600), file(600), file(600, 0.3)]), 10)
  }

  func testIsUnder100UntilEveryFileHasLanded() {
    XCTAssertEqual(DownloadProgress.percent([file(36000, done: true), file(1, 0.999)]), 99)
    XCTAssertEqual(DownloadProgress.percent([file(100, done: true), file(100, 1)]), 99)
    XCTAssertEqual(DownloadProgress.percent([file(100, done: true), file(100, done: true)]), 100)
  }

  func testWeighsEachFileTheSameWithNoDurations() {
    XCTAssertEqual(DownloadProgress.percent([file(0, done: true), file(0), file(0), file(0, 0.5)]), 37)
    XCTAssertEqual(DownloadProgress.percent([file(.nan, done: true), file(-5)]), 50)
    // One file of no known length: by duration it would weigh nothing, and the book read 99.
    XCTAssertEqual(DownloadProgress.percent([file(3600, done: true), file(0)]), 50)
  }

  func testReadsNothingIntoNoFilesOrABadFraction() {
    XCTAssertEqual(DownloadProgress.percent([]), 0)
    XCTAssertEqual(DownloadProgress.percent([file(60, 2), file(60)]), 50)
    XCTAssertEqual(DownloadProgress.percent([file(60, -1), file(60, .infinity)]), 0)
  }

  func testNeverSaysLessThanItReachedNor100WhileDownloading() {
    // A launch: the bytes in flight are gone, the files landed are a quarter.
    XCTAssertEqual(DownloadProgress.shown(25, reached: 60), 60)
    XCTAssertEqual(DownloadProgress.shown(62, reached: 60), 62)
    XCTAssertEqual(DownloadProgress.shown(30, reached: nil), 30)
    // Every file landed, the record not yet ready.
    XCTAssertEqual(DownloadProgress.shown(100, reached: nil), 99)
    XCTAssertEqual(DownloadProgress.shown(-4, reached: 140), 99)
  }

  func testPublishesInFivePercentSteps() {
    XCTAssertEqual([0, 4, 5, 44, 45, 99, 100].map(DownloadProgress.published), [0, 0, 5, 40, 45, 95, 100])
    XCTAssertEqual(DownloadProgress.published(-3), 0)
    XCTAssertEqual(DownloadProgress.published(140), 100)
  }

  func testATransfersShareFromItsBytes() {
    XCTAssertEqual(DownloadProgress.fraction(received: 25, expected: 100), 0.25)
    XCTAssertEqual(DownloadProgress.fraction(received: 150, expected: 100), 1)
    XCTAssertEqual(DownloadProgress.fraction(received: 50, expected: 0), 0)
    XCTAssertEqual(DownloadProgress.fraction(received: 50, expected: -1), 0)
  }

  func testCountsTheFilesTheServerHasReady() {
    let paths = ["a", "b", "c", "d"]
    XCTAssertEqual(DownloadProgress.filesReady(paths, handed: ["a"], serverReady: ["a", "b"]), 2)
    // A file handed over at a launch before this one counts though no answer named it yet.
    XCTAssertEqual(DownloadProgress.filesReady(paths, handed: ["a", "c"], serverReady: []), 2)
    // Only the book's own files.
    XCTAssertEqual(DownloadProgress.filesReady(paths, handed: [], serverReady: ["x", "d"]), 1)
  }

  func testNamesTheWaitARecordsMessageSays() {
    XCTAssertEqual(DownloadWait(message: "Waiting for a connection"), .connection)
    XCTAssertEqual(DownloadWait(message: "Waiting for the server"), .server)
    XCTAssertEqual(DownloadWait(message: DownloadWait.server.message), .server)
    XCTAssertNil(DownloadWait(message: "This book is no longer on the server."))
    XCTAssertNil(DownloadWait(message: nil))
  }
}
