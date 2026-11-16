// The download index read late joins what was queued meanwhile, unless every book was removed
// meanwhile (an account left): then what it holds is dropped (fe#323).
import XCTest

@testable import WatchCore

private struct Row: Identifiable, Equatable {
  var id: String
  var account: String
}

final class DownloadIndexJoinTests: XCTestCase {
  private let kept = [Row(id: "1|a", account: "old"), Row(id: "1|b", account: "old")]

  func testQueuedMeanwhileJoinsTheIndexOnceEach() {
    let since = [Row(id: "1|b", account: "new"), Row(id: "1|c", account: "new")]
    let joined = DownloadIndexJoin.join(kept: kept, since: since, forgotten: false)
    XCTAssertEqual(joined.records.map(\.id), ["1|a", "1|b", "1|c"])
    XCTAssertEqual(joined.records[1].account, "old", "the index's copy first")
    XCTAssertEqual(joined.dropped, [])
  }

  func testAnAccountLeftWhileTheIndexWasUnreadDropsWhatItHolds() {
    // The account was replaced with the index unread: `removeAll` cleared memory only, and the
    // new account queued a book since. The old account's books must not join under it.
    let since = [Row(id: "1|b", account: "new")]
    let joined = DownloadIndexJoin.join(kept: kept, since: since, forgotten: true)
    XCTAssertEqual(joined.records, since)
    XCTAssertEqual(joined.dropped, kept)
  }

  func testNothingQueuedAndNothingForgottenIsTheIndex() {
    let joined = DownloadIndexJoin.join(kept: kept, since: [Row](), forgotten: false)
    XCTAssertEqual(joined.records, kept)
    XCTAssertEqual(DownloadIndexJoin.join(kept: kept, since: [Row](), forgotten: true).records, [])
  }
}
