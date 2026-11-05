// When `watch-state` goes to the phone: once per launch whatever it is, then on a change, and a
// refused send stays owed until the session takes it.
import XCTest

@testable import WatchCore

private func state(signedIn: Bool = true, unsent: Int = 0) -> WatchState {
  WatchState(signedIn: signedIn, serverId: signedIn ? "srv" : nil, userId: signedIn ? 1 : nil,
             appVersion: "2.6.0", books: [], unsentEvents: unsent, couldntSync: 0)
}

final class StatePublicationTests: XCTestCase {
  func testOwesNothingBeforeTheFirstState() {
    XCTAssertNil(StatePublication().due)
  }

  func testAStateTheSessionTookIsNotOwedAgain() {
    var p = StatePublication()
    p.update(state())
    p.tookIt(state())
    XCTAssertNil(p.due)
    p.update(state())
    XCTAssertNil(p.due)
  }

  func testARefusedSendStaysOwedForEveryNextMoment() {
    var p = StatePublication()
    p.update(state())
    // Refused (WCError 7018 at launch): `tookIt` is never called.
    XCTAssertEqual(p.due, state())
    p.tookIt(state())
    XCTAssertNil(p.due)
  }

  func testAChangeIsOwedAndTheLatestWins() {
    var p = StatePublication()
    p.update(state(unsent: 1))
    p.tookIt(state(unsent: 1))
    p.update(state(unsent: 2))
    p.update(state(unsent: 3))
    XCTAssertEqual(p.due, state(unsent: 3))
  }

  func testOnlyAChangedStateIsNews() {
    var p = StatePublication()
    XCTAssertTrue(p.update(state(unsent: 1)))
    // Refused, so still owed, but the same state again is no reason to try.
    XCTAssertFalse(p.update(state(unsent: 1)))
    XCTAssertEqual(p.due, state(unsent: 1))
    XCTAssertTrue(p.update(state(unsent: 2)))
  }

  func testAChangeBackAfterARefusalOwesNothing() {
    // The session still holds what it last took, and that is the latest again.
    var p = StatePublication()
    p.update(state(unsent: 1))
    p.tookIt(state(unsent: 1))
    p.update(state(unsent: 2))
    p.update(state(unsent: 1))
    XCTAssertNil(p.due)
  }
}
