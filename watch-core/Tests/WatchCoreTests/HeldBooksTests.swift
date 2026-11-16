// A book the phone sent that the watch can't take yet: held, released on ready, aged, capped,
// kept across a kill, and never silent when it can't come.
import XCTest

@testable import WatchCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private let A = "srv-a.1"
private let B = "srv-b.2"

private func bookA(_ path: String = "A/One", title: String = "One") -> BookMessage {
  BookMessage(serverId: "srv-a", userId: 1, ref: BookRef(libraryId: 1, path: path), title: title, author: "Ann")
}

private func bookB(_ path: String = "B/One", title: String = "One") -> BookMessage {
  BookMessage(serverId: "srv-b", userId: 2, ref: BookRef(libraryId: 1, path: path), title: title, author: nil)
}

@MainActor
final class HeldBooksTests: XCTestCase {
  private func tempURL() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return dir.appendingPathComponent("held-books.json")
  }

  // MARK: - Held, then released

  func testHeldThenReleasedOnReady() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    XCTAssertEqual(held.due(accountId: nil, ready: false, now: t0), [], "still signing in")
    XCTAssertEqual(held.due(accountId: A, ready: false, now: t0), [], "signed in, not ready (too old)")
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0), [bookA()])
    XCTAssertEqual(held.books.count, 1, "kept until it is on the watch")
    held.settle(accountId: A, onWatch: [bookA().ref], now: t0)
    XCTAssertEqual(held.books, [])
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0), [])
  }

  func testReleasesInTheOrderTheyCame() {
    let held = HeldBooks(url: nil)
    held.hold(bookA("A/One"), now: t0)
    held.hold(bookB(), now: t0)
    held.hold(bookA("A/Two"), now: t0)
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0).map(\.ref.path), ["A/One", "A/Two"])
  }

  func testAKillBetweenQueueingAndSettlingLosesNothing() throws {
    let url = try tempURL()
    let held = HeldBooks(url: url)
    held.hold(bookA(), now: t0)
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0), [bookA()])
    // Killed before the download index said so: the next launch has it to release again.
    XCTAssertEqual(HeldBooks(url: url).due(accountId: A, ready: true, now: t0), [bookA()])
  }

  // MARK: - A failed pair

  func testAFailedPairKeepsTheBookForTheNextSendAgain() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    // The exchange failed: nothing happens to the book, and no account or ready came of it.
    let later = t0.addingTimeInterval(3600)
    XCTAssertEqual(held.due(accountId: nil, ready: false, now: later), [])
    XCTAssertTrue(held.books[0].waiting, "a failed sign-in is not a definite end")
    // Send again from the phone: this one succeeded.
    XCTAssertEqual(held.due(accountId: A, ready: true, now: later), [bookA()])
  }

  func testAFailedPairNeverSignedInAgesOutVisibly() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    let past = t0.addingTimeInterval(HeldBooks.MAX_AGE)
    XCTAssertEqual(held.due(accountId: A, ready: true, now: past), [], "too old to start by itself")
    XCTAssertEqual(held.books.map(\.waiting), [false])
    XCTAssertEqual(held.stateRows(accountId: A).map(\.state), [.failed])
  }

  // MARK: - The wrong account

  func testAnotherAccountsBookStaysHeldThenAgesOut() {
    let held = HeldBooks(url: nil)
    held.hold(bookB(), now: t0)
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0), [], "signed in to another account")
    let justBefore = t0.addingTimeInterval(HeldBooks.MAX_AGE - 1)
    held.settle(accountId: A, onWatch: [], now: justBefore)
    XCTAssertTrue(held.books[0].waiting)
    XCTAssertEqual(held.due(accountId: B, ready: true, now: justBefore), [bookB()], "its account came in time")
    held.settle(accountId: A, onWatch: [], now: t0.addingTimeInterval(HeldBooks.MAX_AGE))
    XCTAssertFalse(held.books[0].waiting)
    XCTAssertEqual(held.due(accountId: B, ready: true, now: t0.addingTimeInterval(HeldBooks.MAX_AGE)), [])
  }

  func testGivingUpTouchesOnlyThatAccount() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.hold(bookB(), now: t0)
    held.giveUp(accountId: A, now: t0)
    XCTAssertEqual(held.books.map(\.waiting), [false, true])
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0), [], "a book given up on is not released")
    XCTAssertEqual(held.due(accountId: B, ready: true, now: t0), [bookB()])
  }

  func testLeavingAnAccountDeletesItsRowsWaitingOrGivenUpOn() {
    let held = HeldBooks(url: nil)
    held.hold(bookA("A/Waiting"), now: t0)
    held.hold(bookA("A/GivenUp"), now: t0.addingTimeInterval(-HeldBooks.MAX_AGE))
    held.settle(accountId: nil, onWatch: [], now: t0)
    held.hold(bookB(), now: t0)
    XCTAssertEqual(held.books.filter { !$0.waiting }.map(\.book.ref.path), ["A/GivenUp"])
    held.forget(accountId: A, now: t0)
    XCTAssertEqual(held.books.map(\.book), [bookB()], "only the account left")
    XCTAssertTrue(held.books[0].waiting)
    XCTAssertEqual(held.stateRows(accountId: A), [])
  }

  func testLeavingWithNoAccountTouchesNothing() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.forget(accountId: nil, now: t0)
    XCTAssertEqual(held.books.count, 1)
  }

  func testTheSamePathOnAnotherServerIsAnotherBook() {
    let held = HeldBooks(url: nil)
    let sameRef = BookMessage(serverId: "srv-b", userId: 2, ref: bookA().ref, title: "Other", author: nil)
    held.hold(bookA(), now: t0)
    held.hold(sameRef, now: t0)
    XCTAssertEqual(held.books.count, 2)
    held.settle(accountId: A, onWatch: [bookA().ref], now: t0)
    XCTAssertEqual(held.books.map(\.book), [sameRef], "only the signed-in account's book is on the watch")
  }

  // MARK: - Age

  func testAGivenUpBookIsForgottenAfterItsKeep() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.giveUp(accountId: A, now: t0)
    held.settle(accountId: nil, onWatch: [], now: t0.addingTimeInterval(HeldBooks.GAVE_UP_KEEP - 1))
    XCTAssertEqual(held.books.count, 1)
    held.settle(accountId: nil, onWatch: [], now: t0.addingTimeInterval(HeldBooks.GAVE_UP_KEEP))
    XCTAssertEqual(held.books, [])
  }

  // MARK: - The cap

  func testOverTheCapTheOldestWaitingIsGivenUpOnNotLostSilently() {
    let held = HeldBooks(url: nil)
    for i in 0..<HeldBooks.MAX_BOOKS { held.hold(bookA("A/\(i)"), now: t0.addingTimeInterval(Double(i))) }
    XCTAssertTrue(held.books.allSatisfy(\.waiting))
    held.hold(bookA("A/new"), now: t0.addingTimeInterval(100))
    let waiting = held.books.filter(\.waiting)
    XCTAssertEqual(waiting.count, HeldBooks.MAX_BOOKS)
    XCTAssertFalse(waiting.contains { $0.book.ref.path == "A/0" })
    XCTAssertTrue(waiting.contains { $0.book.ref.path == "A/new" }, "the newest is what was just asked for")
    let failed = held.stateRows(accountId: A).filter { $0.state == .failed }
    XCTAssertEqual(failed.map(\.ref.path), ["A/0"])
  }

  func testBooksGivenUpOnAreCappedTooOldestFirst() {
    let held = HeldBooks(url: nil)
    for i in 0..<(HeldBooks.MAX_BOOKS + 1) {
      let at = t0.addingTimeInterval(Double(i))
      held.hold(bookA("A/\(i)"), now: at)
      held.giveUp(accountId: A, now: at)
    }
    XCTAssertEqual(held.books.count, HeldBooks.MAX_BOOKS)
    XCTAssertFalse(held.books.contains { $0.book.ref.path == "A/0" })
    XCTAssertTrue(held.books.contains { $0.book.ref.path == "A/\(HeldBooks.MAX_BOOKS)" })
  }

  // MARK: - Duplicates

  func testTheSameBookAgainIsOneRowAndWaitsAfresh() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(title: "Old title"), now: t0)
    let later = t0.addingTimeInterval(HeldBooks.MAX_AGE - 1)
    held.hold(bookA(title: "New title"), now: later)
    XCTAssertEqual(held.books.count, 1)
    XCTAssertEqual(held.books[0].book.title, "New title")
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0.addingTimeInterval(HeldBooks.MAX_AGE)).count, 1)
  }

  func testAGivenUpBookSentAgainWaitsAgain() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.giveUp(accountId: A, now: t0)
    held.hold(bookA(), now: t0.addingTimeInterval(10))
    XCTAssertEqual(held.books.map(\.waiting), [true])
    XCTAssertEqual(held.stateRows(accountId: A).map(\.state), [.queued])
  }

  func testABookAlreadyOnTheWatchIsNoLongerHeldOrReported() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.giveUp(accountId: A, now: t0)
    // Downloaded another way (the watch's own button, or sent again once ready).
    held.settle(accountId: A, onWatch: [bookA().ref], now: t0)
    XCTAssertEqual(held.stateRows(accountId: A), [])
  }

  // MARK: - watch-state

  func testReportsQueuedThenFailedWithNoBytes() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    XCTAssertEqual(held.stateRows(accountId: A),
                   [WatchStateBook(ref: bookA().ref, title: "One", state: .queued, bytes: nil, addedAt: t0)])
    held.giveUp(accountId: A, now: t0)
    XCTAssertEqual(held.stateRows(accountId: A),
                   [WatchStateBook(ref: bookA().ref, title: "One", state: .failed, bytes: nil, addedAt: t0)])
  }

  // Its books read as the account the state names, so another's would be listed under the wrong one.
  func testReportsARowOnlyUnderItsOwnAccount() {
    let held = HeldBooks(url: nil)
    held.hold(bookB(), now: t0)
    XCTAssertEqual(held.stateRows(accountId: A), [])
    XCTAssertEqual(held.stateRows(accountId: nil), [])
    XCTAssertEqual(held.stateRows(accountId: B).count, 1)
  }

  func testTheRowsFitTheMessageWithNoNewField() throws {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.giveUp(accountId: A, now: t0)
    let state = WatchState(signedIn: true, serverId: "srv-a", userId: 1, appVersion: "2.6.0",
                           books: held.stateRows(accountId: A), unsentEvents: 0, couldntSync: 0, lastSyncAt: nil)
    let books = try XCTUnwrap(PhoneMessages.encode(state)["books"] as? [[String: Any]])
    XCTAssertEqual(books[0]["state"] as? String, "failed")
    XCTAssertEqual(Set(books[0].keys), ["library_id", "path", "title", "state", "added_at"])
  }

  // fe#219: the phone tells a copy from before its last Send by this.
  func testARowSaysItWasAddedWhenTheListenerAskedElseWhenItArrived() {
    let held = HeldBooks(url: nil)
    var asked = bookA()
    asked.askedAt = t0.addingTimeInterval(-30)
    held.hold(asked, now: t0)
    held.hold(bookA("A/Old"), now: t0.addingTimeInterval(5))
    XCTAssertEqual(held.stateRows(accountId: A).map(\.addedAt), [t0.addingTimeInterval(-30), t0.addingTimeInterval(5)])
  }

  func testSettlingHandsBackTheBooksAskedForAgainForACopyAlreadyHere() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.hold(bookA("A/GivenUp"), now: t0)
    held.giveUp(accountId: A, now: t0)
    held.hold(bookA(), now: t0)
    let settled = held.settle(accountId: A, onWatch: [bookA().ref, bookA("A/GivenUp").ref], now: t0)
    XCTAssertEqual(settled, [bookA()], "only one still waiting: a book given up on was not asked for now")
    XCTAssertEqual(held.books, [])
  }

  // MARK: - Across a kill

  func testPersistenceRoundTrip() throws {
    let url = try tempURL()
    let held = HeldBooks(url: url)
    held.hold(bookA(), now: t0)
    held.hold(bookB(), now: t0.addingTimeInterval(5))
    held.giveUp(accountId: B, now: t0.addingTimeInterval(6))
    let again = HeldBooks(url: url)
    XCTAssertEqual(again.books, held.books)
    XCTAssertEqual(again.books[0].book.author, "Ann")
    XCTAssertEqual(again.books[1].gaveUpAt, t0.addingTimeInterval(6))
    XCTAssertEqual(again.due(accountId: A, ready: true, now: t0), [bookA()])
  }

  func testTheAgeCarriesAcrossAKill() throws {
    let url = try tempURL()
    HeldBooks(url: url).hold(bookA(), now: t0)
    let again = HeldBooks(url: url)
    XCTAssertEqual(again.due(accountId: A, ready: true, now: t0.addingTimeInterval(HeldBooks.MAX_AGE)), [])
    XCTAssertEqual(HeldBooks(url: url).stateRows(accountId: A).map(\.state), [.failed])
  }

  func testTheFileGoesWhenNothingIsLeft() throws {
    let url = try tempURL()
    let held = HeldBooks(url: url)
    held.hold(bookA(), now: t0)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    held.settle(accountId: A, onWatch: [bookA().ref], now: t0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  // What `publishState` asks before it lets a row go for a download record.
  func testAWriteSaysWhetherItLanded() throws {
    let url = try tempURL()
    let file = JSONFile<[String]>(url: url)
    XCTAssertTrue(file.write(["one"]))
    XCTAssertTrue(file.write(nil))
    // A file where its folder should be: nothing can land there.
    try Data().write(to: url)
    XCTAssertFalse(JSONFile<[String]>(url: url.appendingPathComponent("under")).write(["one"]))
  }

  func testAnUnreadableFileReadsAsNothing() throws {
    let url = try tempURL()
    try Data("not json".utf8).write(to: url)
    XCTAssertEqual(HeldBooks(url: url).books, [])
  }

  // MARK: - remove

  private func removeA(_ path: String = "A/One") -> RemoveMessage {
    RemoveMessage(serverId: "srv-a", userId: 1, ref: BookRef(libraryId: 1, path: path))
  }

  func testRemoveForTheSignedInAccountGoesAndClearsItsRow() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    let ticket = held.noteRemove(removeA(), now: t0)
    XCTAssertTrue(held.finishRemove(ticket, accountId: A, now: t0))
    XCTAssertEqual(held.books, [])
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0), [], "it never starts")
  }

  func testRemoveClearsARowGivenUpOn() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.giveUp(accountId: A, now: t0)
    XCTAssertEqual(held.stateRows(accountId: A).map(\.state), [.failed])
    XCTAssertTrue(held.finishRemove(held.noteRemove(removeA(), now: t0), accountId: A, now: t0))
    XCTAssertEqual(held.stateRows(accountId: A), [])
  }

  func testRemoveWithNoRowStillTakesTheBook() {
    let held = HeldBooks(url: nil)
    XCTAssertTrue(held.finishRemove(held.noteRemove(removeA(), now: t0), accountId: A, now: t0))
  }

  func testARepeatedRemoveChangesNothingMore() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    held.hold(bookA("A/Two"), now: t0)
    XCTAssertTrue(held.finishRemove(held.noteRemove(removeA(), now: t0), accountId: A, now: t0))
    let left = held.books
    // The phone's Remove again, when the first did get here. `downloads.remove` then finds no record.
    XCTAssertTrue(held.finishRemove(held.noteRemove(removeA(), now: t0), accountId: A, now: t0))
    XCTAssertEqual(held.books, left)
  }

  func testABookSentBehindARepeatedRemoveStands() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    let first = held.noteRemove(removeA(), now: t0)
    let repeated = held.noteRemove(removeA(), now: t0)
    let later = t0.addingTimeInterval(1)
    held.hold(bookA(), now: later)
    XCTAssertTrue(held.finishRemove(first, accountId: A, now: later))
    // The repeat is still to come, so the record it is about settles no row yet.
    held.settle(accountId: A, onWatch: [bookA().ref], now: later)
    XCTAssertTrue(held.finishRemove(repeated, accountId: A, now: later))
    XCTAssertEqual(held.due(accountId: A, ready: true, now: later), [bookA()])
    held.settle(accountId: A, onWatch: [bookA().ref], now: later)
    XCTAssertEqual(held.books, [], "both turns over, the record speaks for it again")
  }

  func testRemoveIsRefusedSignedOutOrOnAnotherAccountAndChangesNothing() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    XCTAssertFalse(held.finishRemove(held.noteRemove(removeA(), now: t0), accountId: nil, now: t0), "signed out")
    XCTAssertFalse(held.finishRemove(held.noteRemove(removeA(), now: t0), accountId: B, now: t0), "another account")
    XCTAssertEqual(held.books.count, 1, "still held")
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0), [bookA()])
  }

  func testRemoveLeavesAnotherAccountsRowForTheSameBook() {
    let held = HeldBooks(url: nil)
    let same = BookMessage(serverId: "srv-b", userId: 2, ref: bookA().ref, title: "One", author: nil)
    held.hold(same, now: t0)
    held.hold(bookA(), now: t0)
    XCTAssertTrue(held.finishRemove(held.noteRemove(removeA(), now: t0), accountId: A, now: t0))
    XCTAssertEqual(held.books.map(\.book.accountId), [B])
  }

  func testABookSentAgainAfterARemoveSurvivesItsTurn() {
    let held = HeldBooks(url: nil)
    held.hold(bookA(), now: t0)
    let ticket = held.noteRemove(removeA(), now: t0)
    // Held the moment it arrives, ahead of the remove's turn.
    held.hold(bookA(), now: t0.addingTimeInterval(1))
    XCTAssertTrue(held.finishRemove(ticket, accountId: A, now: t0.addingTimeInterval(1)))
    XCTAssertEqual(held.due(accountId: A, ready: true, now: t0.addingTimeInterval(1)), [bookA()])
  }

  func testABookFirstSentAfterARemoveSurvivesItsTurn() {
    let held = HeldBooks(url: nil)
    let ticket = held.noteRemove(removeA(), now: t0)
    held.hold(bookA(), now: t0)
    XCTAssertTrue(held.finishRemove(ticket, accountId: A, now: t0))
    XCTAssertEqual(held.books.count, 1)
  }

  func testARecordAboutToGoSettlesNoRow() {
    let held = HeldBooks(url: nil)
    let ticket = held.noteRemove(removeA(), now: t0)
    held.hold(bookA(), now: t0)
    // The old record is still in the index: settled against it, the book sent again would be lost.
    held.settle(accountId: A, onWatch: [bookA().ref], now: t0)
    XCTAssertEqual(held.books.count, 1)
    XCTAssertTrue(held.finishRemove(ticket, accountId: A, now: t0))
    held.settle(accountId: A, onWatch: [bookA().ref], now: t0)
    XCTAssertEqual(held.books, [], "its turn over, the record speaks for it again")
  }

  func testStoppingThePlayingBookOnItsTurnSettlesNoRow() {
    let held = HeldBooks(url: nil)
    let ticket = held.noteRemove(removeA(), now: t0)
    held.hold(bookA(), now: t0)
    var taken = false
    // Stopping it closes its span, which publishes with its record still in the index.
    XCTAssertTrue(held.finishRemove(ticket, accountId: A, now: t0) {
      taken = true
      held.settle(accountId: A, onWatch: [bookA().ref], now: t0)
    })
    XCTAssertTrue(taken)
    XCTAssertEqual(held.books.count, 1, "the book sent again stands")
  }

  // fe#219: a `remove` asked before the book was (a Remove asked again keeps the first one's time).
  func testARemoveAskedBeforeTheBookLeavesItsRow() {
    let held = HeldBooks(url: nil)
    var book = bookA()
    book.askedAt = t0.addingTimeInterval(10)
    held.hold(book, now: t0)
    var earlier = removeA()
    earlier.askedAt = t0
    XCTAssertTrue(held.finishRemove(held.noteRemove(earlier, now: t0), accountId: A, now: t0))
    XCTAssertEqual(held.books.map(\.book), [book])
    var later = removeA()
    later.askedAt = t0.addingTimeInterval(10)
    XCTAssertTrue(held.finishRemove(held.noteRemove(later, now: t0), accountId: A, now: t0))
    XCTAssertEqual(held.books, [], "asked at the same moment or after, it goes")
  }

  // MARK: - remove, across a kill (fe#219)

  func testARemoveNotHandledYetSurvivesAKillAndIsHandedOutOnce() throws {
    let url = try tempURL()
    let held = HeldBooks(url: url)
    held.hold(bookA(), now: t0)
    let ticket = held.noteRemove(removeA(), now: t0)
    XCTAssertEqual(held.takeLeftoverRemoves(), [], "this run's own are in their turn already")
    let again = HeldBooks(url: url)
    XCTAssertEqual(again.removes, [ticket])
    let leftovers = again.takeLeftoverRemoves()
    XCTAssertEqual(leftovers, [ticket])
    XCTAssertEqual(again.takeLeftoverRemoves(), [], "once")
    // Still in its turn, its book's record settles no row.
    again.settle(accountId: A, onWatch: [bookA().ref], now: t0)
    XCTAssertEqual(again.books.count, 1)
    XCTAssertTrue(again.finishRemove(leftovers[0], accountId: A, now: t0))
    XCTAssertEqual(again.books, [], "the row it found goes with it")
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "nothing left to keep")
  }

  func testARefusedLeftoverRemoveIsDoneWith() throws {
    let url = try tempURL()
    _ = HeldBooks(url: url).noteRemove(removeA(), now: t0)
    let again = HeldBooks(url: url)
    XCTAssertFalse(again.finishRemove(again.takeLeftoverRemoves()[0], accountId: B, now: t0))
    XCTAssertEqual(HeldBooks(url: url).removes, [])
  }

  func testARemoveNeverHandledAgesOut() {
    let held = HeldBooks(url: nil)
    _ = held.noteRemove(removeA(), now: t0)
    held.settle(accountId: A, onWatch: [], now: t0.addingTimeInterval(HeldBooks.MAX_AGE - 1))
    XCTAssertEqual(held.removes.count, 1)
    held.settle(accountId: A, onWatch: [], now: t0.addingTimeInterval(HeldBooks.MAX_AGE))
    XCTAssertEqual(held.removes, [])
  }

  func testTheFileFromBefore27StillReads() throws {
    let url = try tempURL()
    let row = HeldBook(book: bookA(), heldAt: t0)
    XCTAssertTrue(JSONFile<[HeldBook]>(url: url).write([row]))
    let held = HeldBooks(url: url)
    XCTAssertEqual(held.books, [row])
    XCTAssertEqual(held.removes, [])
    // Written again in the new shape, the books with the removes.
    _ = held.noteRemove(removeA(), now: t0)
    XCTAssertEqual(HeldBooks(url: url).books, [row])
    XCTAssertEqual(HeldBooks(url: url).removes.count, 1)
  }

  func testARefusedRemoveTakesNoBook() {
    let held = HeldBooks(url: nil)
    XCTAssertFalse(held.finishRemove(held.noteRemove(removeA(), now: t0), accountId: B, now: t0) {
      XCTFail("another account's book stays")
    })
  }

  // MARK: - Home's On the way

  func testHomeListsWaitingRowsOnceEach() {
    let held = HeldBooks(url: nil)
    held.hold(bookA("A/Beside"), now: t0)
    held.hold(bookA("A/Alone"), now: t0)
    held.hold(bookB("B/Other"), now: t0)
    held.hold(bookA("A/GivenUp"), now: t0.addingTimeInterval(-HeldBooks.MAX_AGE))
    held.settle(accountId: A, onWatch: [], now: t0)
    let rows = HeldBooks.waiting(held.books, accountId: A, records: [bookA("A/Beside").ref, bookB("B/Other").ref])
    XCTAssertEqual(rows.map(\.book.ref.path), ["A/Alone", "B/Other"],
                   "not one beside its record, not one given up on; a record is this account's alone")
  }

  func testOnlyWhatIsStillComingIsOnTheWay() {
    let coming: [WatchStateBook.State] = [.queued, .preparing, .downloading]
    XCTAssertTrue(coming.allSatisfy(\.onTheWay))
    XCTAssertFalse(WatchStateBook.State.ready.onTheWay)
    XCTAssertFalse(WatchStateBook.State.failed.onTheWay)
  }
}
