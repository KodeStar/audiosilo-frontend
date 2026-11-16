import XCTest
@testable import WatchCore

final class StartRefusalTests: XCTestCase {
  // Monotonic stamps (fe#320): what the wall clock says plays no part.
  private let t0 = StartRefusal.Stamp.now
  private func at(_ s: TimeInterval) -> StartRefusal.Stamp { t0.advanced(by: .seconds(s)) }

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

final class InterruptionResumeTests: XCTestCase {
  private let t0 = StartRefusal.Stamp.now
  private func at(_ s: TimeInterval) -> StartRefusal.Stamp { t0.advanced(by: .seconds(s)) }

  func testAnInterruptionWhilePlayingPlaysOnWhenItEndsWithShouldResume() {
    var i = InterruptionResume()
    i.began(playing: true, at: at(0))
    XCTAssertTrue(i.ended(shouldResume: true))
    XCTAssertFalse(i.ended(shouldResume: true), "asked once")
  }

  func testAnEndWithoutShouldResumeStaysPaused() {
    var i = InterruptionResume()
    i.began(playing: true, at: at(0))
    XCTAssertFalse(i.ended(shouldResume: false))
  }

  func testTheSystemsPauseJustBeforeTheBeganCountsAsPlaying() {
    // Either order: the system paused the player, then Siri's `began` came 1.5 s later.
    var i = InterruptionResume()
    i.systemPaused(at: at(0))
    i.began(playing: false, at: at(1.5))
    XCTAssertTrue(i.ended(shouldResume: true))
  }

  func testABeganPastTheSlackOfTheSystemsPauseDoesNotResume() {
    var i = InterruptionResume()
    i.systemPaused(at: at(0))
    i.began(playing: false, at: at(StartRefusal.INTERRUPTION_SLACK))
    XCTAssertFalse(i.ended(shouldResume: true))
  }

  func testHeadphonesGoneDuringAnInterruptionKeepTheBookPaused() {
    // Playing, Siri begins (the book pauses), the headphones go while it is paused: its end must not
    // play the book on the watch speaker (fe#320).
    var i = InterruptionResume()
    i.began(playing: true, at: at(0))
    i.held()
    XCTAssertFalse(i.ended(shouldResume: true))
  }

  func testHeadphonesGoneAfterTheSystemsPauseAreNotTakenForTheInterruption() {
    var i = InterruptionResume()
    i.systemPaused(at: at(0))
    i.held()
    i.began(playing: false, at: at(0.5))
    XCTAssertFalse(i.ended(shouldResume: true), "the pause was the headphones', not Siri's")
  }
}
