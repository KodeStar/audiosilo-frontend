import XCTest
@testable import WatchCore

final class StartRefusalTests: XCTestCase {
  private let t0 = Date(timeIntervalSince1970: 1_000_000)
  private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

  func testAPauseThenAnInterruptionWithinTheSlackShowsNoMessage() {
    var r = StartRefusal()
    r.refused(at: at(0))
    XCTAssertNil(r.message(at: at(1)), "the message waits for the slack")
    r.explained(at: at(1.5)) // Siri's `began`, 1.5 s after the system paused the player.
    XCTAssertNil(r.message(at: at(StartRefusal.INTERRUPTION_SLACK)))
    XCTAssertNil(r.message(at: at(10)))
  }

  func testARefusalNothingExplainsShowsItsMessageAfterTheSlackOnce() {
    var r = StartRefusal()
    r.refused(at: at(0))
    XCTAssertNil(r.message(at: at(StartRefusal.INTERRUPTION_SLACK - 0.1)))
    XCTAssertEqual(r.message(at: at(StartRefusal.INTERRUPTION_SLACK)), PlaybackFailure.audioStart.message)
    XCTAssertNil(r.message(at: at(StartRefusal.INTERRUPTION_SLACK + 1)), "given once")
  }

  func testAnInterruptionAfterTheSlackDoesNotExplainTheRefusal() {
    var r = StartRefusal()
    r.refused(at: at(0))
    r.explained(at: at(StartRefusal.INTERRUPTION_SLACK + 0.5)) // A timer that fired late.
    XCTAssertEqual(r.message(at: at(StartRefusal.INTERRUPTION_SLACK + 0.6)), PlaybackFailure.audioStart.message)
  }

  func testAnotherPlayDropsAnEarlierRefusalAndANewOneWaitsItsOwnSlack() {
    var r = StartRefusal()
    r.refused(at: at(0))
    r.reset() // Play again within the slack.
    XCTAssertNil(r.message(at: at(StartRefusal.INTERRUPTION_SLACK)))
    r.refused(at: at(1))
    XCTAssertNil(r.message(at: at(StartRefusal.INTERRUPTION_SLACK)), "the first refusal's timer finds the second waiting")
    XCTAssertNotNil(r.message(at: at(1 + StartRefusal.INTERRUPTION_SLACK)))
  }

  func testNothingRefusedSaysNothing() {
    var r = StartRefusal()
    r.explained(at: at(0))
    XCTAssertNil(r.message(at: at(5)))
  }

  func testHeadphonesGonePauseAPlayAlsoWhileItsQueueSettles() {
    // `landed` would otherwise start a settling queue on whatever route is left.
    XCTAssertTrue(RouteChange.deviceGone.pauses(playing: true))
    XCTAssertFalse(RouteChange.deviceGone.pauses(playing: false))
    XCTAssertFalse(RouteChange.other.pauses(playing: true), "a new device or a category change keeps playing")
  }

  func testHeadphonesGoneWithinTheSlackExplainARefusedStart() {
    var r = StartRefusal()
    r.refused(at: at(0))
    XCTAssertTrue(RouteChange.deviceGone.explainsRefusal)
    XCTAssertFalse(RouteChange.other.explainsRefusal)
    r.explained(at: at(0.4))
    XCTAssertNil(r.message(at: at(StartRefusal.INTERRUPTION_SLACK)))
  }
}
