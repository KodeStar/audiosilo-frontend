import XCTest
@testable import WatchCore

final class StartRefusalTests: XCTestCase {
  private let t0 = Date(timeIntervalSince1970: 1_000_000)
  private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

  func testAPauseThenAnInterruptionWithinTheSlackShowsNoMessage() {
    var r = StartRefusal()
    r.refused(at: at(0))
    r.explained(at: at(1.5)) // Siri's `began`, 1.5 s after the system paused the player.
    XCTAssertNil(r.message(for: at(0)), "its timer finds it explained")
  }

  func testARefusalNothingExplainsShowsItsMessageOnce() {
    var r = StartRefusal()
    r.refused(at: at(0))
    XCTAssertEqual(r.message(for: at(0)), PlaybackFailure.audioStart.message)
    XCTAssertNil(r.message(for: at(0)), "given once")
  }

  func testAnInterruptionAfterTheSlackDoesNotExplainTheRefusal() {
    var r = StartRefusal()
    r.refused(at: at(0))
    r.explained(at: at(StartRefusal.INTERRUPTION_SLACK + 0.5)) // Before a timer that fired late.
    XCTAssertEqual(r.message(for: at(0)), PlaybackFailure.audioStart.message)
  }

  func testAnotherPlayDropsAnEarlierRefusalAndANewOneWaitsItsOwnSlack() {
    var r = StartRefusal()
    r.refused(at: at(0))
    r.reset() // Play again within the slack.
    XCTAssertNil(r.message(for: at(0)))
    r.refused(at: at(1))
    XCTAssertNil(r.message(for: at(0)), "the first refusal's timer finds the second waiting")
    XCTAssertNotNil(r.message(for: at(1)))
  }

  func testNothingRefusedSaysNothing() {
    var r = StartRefusal()
    r.explained(at: at(0))
    XCTAssertNil(r.message(for: at(0)))
  }

  func testTheSlackWindowCountsFromThePause() {
    // The engine's `justPaused`: a `began` this soon after the system's pause was that pause.
    XCTAssertTrue(StartRefusal.withinSlack(of: at(0), at: at(StartRefusal.INTERRUPTION_SLACK - 0.1)))
    XCTAssertFalse(StartRefusal.withinSlack(of: at(0), at: at(StartRefusal.INTERRUPTION_SLACK)))
    XCTAssertFalse(StartRefusal.withinSlack(of: nil, at: at(0)), "no pause, nothing within it")
  }
}
