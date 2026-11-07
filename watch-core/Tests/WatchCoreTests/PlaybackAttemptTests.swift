import XCTest
@testable import WatchCore

final class PlaybackAttemptTests: XCTestCase {
  func testPauseThenResumeNearTheOldDeadlineGivesTheNewAttemptItsOwnTime() {
    var attempt = PlaybackAttempt()
    let oldTimeout = attempt.advance()
    XCTAssertTrue(attempt.timedOut(oldTimeout, settling: true, playing: true))
    attempt.advance() // Paused while the first item is still settling.
    let resumedTimeout = attempt.advance()
    XCTAssertFalse(attempt.timedOut(oldTimeout, settling: true, playing: true))
    XCTAssertFalse(attempt.accepts(oldTimeout), "a landed-status recheck from the old play is stale too")
    XCTAssertTrue(attempt.timedOut(resumedTimeout, settling: true, playing: true))
  }

  func testARebuiltOrStoppedQueueIgnoresThePreviousDeadline() {
    var attempt = PlaybackAttempt()
    let firstQueue = attempt.advance()
    let nextQueue = attempt.advance()
    XCTAssertFalse(attempt.timedOut(firstQueue, settling: true, playing: true))
    XCTAssertTrue(attempt.timedOut(nextQueue, settling: true, playing: true))
    attempt.advance() // Stopped and unloaded.
    XCTAssertFalse(attempt.accepts(nextQueue))
  }

  func testALandedOrPausedQueueDoesNotTimeOut() {
    var attempt = PlaybackAttempt()
    let token = attempt.advance()
    XCTAssertFalse(attempt.timedOut(token, settling: false, playing: true))
    XCTAssertFalse(attempt.timedOut(token, settling: true, playing: false))
  }

  func testStartAndSettlingFailuresOfferRetryWithoutTellingTheListenerToDeleteTheBook() {
    for failure in [PlaybackFailure.audioStart, .settling] {
      XCTAssertTrue(failure.message.contains("Play again"))
      XCTAssertFalse(failure.message.contains("Remove"))
      XCTAssertFalse(failure.message.contains("download"))
    }
    XCTAssertTrue(PlaybackFailure.damagedDownload.message.contains("download it again"))
  }

  func testOnlyAMissingOrUnreadableFileIsADamagedDownload() {
    let unparsable = NSError(domain: "AVFoundationErrorDomain", code: -11829)
    let undecodable = NSError(domain: "AVFoundationErrorDomain", code: -11821)
    let missing = NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist)
    let wrappedMissing = NSError(
      domain: "AVFoundationErrorDomain", code: -11800,
      userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOENT))])
    for error in [unparsable, undecodable, missing, wrappedMissing] {
      XCTAssertEqual(PlaybackFailure.ofItemError(error), .damagedDownload, "\(error)")
    }
    let refused = NSError(domain: "AVFoundationErrorDomain", code: -11800)
    let sessionDenied = NSError(domain: "NSOSStatusErrorDomain", code: 561_017_449)
    for error in [refused, sessionDenied] {
      XCTAssertEqual(PlaybackFailure.ofItemError(error), .audioStart, "\(error)")
    }
    XCTAssertEqual(PlaybackFailure.ofItemError(nil), .audioStart)
  }
}
