// Pass 2's Core: speed, skips, chapter moves and Now Playing times (the phone's rate.ts,
// speed-model.ts and the lock screen's chapter rules), the resume plan (pull before play), the
// sleep timer (sleep-timer.ts cut down), the account rules (decision 9), the background sync
// outcome and answer (decision 10), and the DEBUG pair message.
import XCTest

@testable import WatchCore

private func ch(_ i: Int, _ offset: Double, _ length: Double, title: String = "") -> Chapter {
  Chapter(index: i, title: title.isEmpty ? "Chapter \(i + 1)" : title, fileIndex: 0, filePath: "a.mp3", start: offset,
          end: offset + length, bookOffset: offset)
}

/// Three chapters of 10 minutes.
private let chapters = [ch(0, 0, 600), ch(1, 600, 600), ch(2, 1200, 600)]

final class SpeedAndSkipTests: XCTestCase {
  func testClampsSpeedToTheProductRangeAndNotANumberToOne() {
    XCTAssertEqual(PlaybackSpeed.clamp(3), 2)
    XCTAssertEqual(PlaybackSpeed.clamp(0.25), 0.5)
    XCTAssertEqual(PlaybackSpeed.clamp(1.25), 1.25)
    XCTAssertEqual(PlaybackSpeed.clamp(.nan), 1)
    XCTAssertEqual(PlaybackSpeed.clamp(0), 1)
    XCTAssertEqual(PlaybackSpeed.PRESETS, [0.8, 1, 1.1, 1.2, 1.25, 1.3, 1.5, 2])
  }

  func testLabelsASpeed() {
    XCTAssertEqual(PlaybackSpeed.label(1), "1x")
    XCTAssertEqual(PlaybackSpeed.label(2), "2x")
    XCTAssertEqual(PlaybackSpeed.label(1.25), "1.25x")
    XCTAssertEqual(PlaybackSpeed.label(0.8), "0.8x")
  }

  func testASkipStaysInsideTheBook() {
    XCTAssertEqual(Skips.target(position: 10, by: -Skips.BACK, total: 1800), 0)
    XCTAssertEqual(Skips.target(position: 100, by: -Skips.BACK, total: 1800), 85)
    XCTAssertEqual(Skips.target(position: 1790, by: Skips.FORWARD, total: 1800), 1800)
    XCTAssertEqual(Skips.target(position: 100, by: Skips.FORWARD, total: 0), 130)
    XCTAssertEqual(Skips.target(position: .nan, by: Skips.FORWARD, total: 1800), 30)
  }

  func testTimeLeftIsWallClockAtTheSpeed() {
    XCTAssertEqual(Skips.timeLeft(position: 600, total: 1800, rate: 2), 600)
    XCTAssertEqual(Skips.timeLeft(position: 1900, total: 1800, rate: 1), 0)
    XCTAssertTrue(Skips.atEnd(position: 1796, total: 1800))
    XCTAssertFalse(Skips.atEnd(position: 1790, total: 1800))
    XCTAssertFalse(Skips.atEnd(position: 0, total: 0))
  }
}

final class ChapterNavTests: XCTestCase {
  func testPreviousRestartsTheChapterPastThreeSecondsElseGoesBack() {
    XCTAssertEqual(ChapterNav.previous(chapters, 610), 600)
    XCTAssertEqual(ChapterNav.previous(chapters, 602), 0)
    XCTAssertEqual(ChapterNav.previous(chapters, 2), 0)
    XCTAssertNil(ChapterNav.previous([], 100))
  }

  func testNextIsTheNextStartAndNothingAtTheLast() {
    XCTAssertEqual(ChapterNav.next(chapters, 0), 600)
    XCTAssertEqual(ChapterNav.next(chapters, 700), 1200)
    XCTAssertNil(ChapterNav.next(chapters, 1300))
    // A start under 1.5 s ahead is skipped (the phone's slack).
    XCTAssertEqual(ChapterNav.next(chapters, 599), 1200)
  }

  // A seek lands a hair short of the start it asked for (CMTime rounds down: 1234.567 at
  // timescale 600 is 1234.5666...): it is that chapter, and Next goes on from it.
  func testASeekLandingJustShortOfAStartIsThatChapter() {
    let odd = [ch(0, 0, 1234.567), ch(1, 1234.567, 1165.433), ch(2, 2400, 600)]
    let landed = 740_740.0 / 600
    XCTAssertLessThan(landed, 1234.567)
    XCTAssertEqual(ChapterNav.index(odd, landed), 1)
    XCTAssertEqual(NowPlayingTimes.of(chapters: odd, position: landed, total: 3000, bookTitle: "B").chapterIndex, 1)
    // Next twice moves on twice.
    let first = ChapterNav.next(odd, 10)
    XCTAssertEqual(first, 1234.567)
    XCTAssertEqual(ChapterNav.next(odd, landed), 2400)
    // Previous right after landing goes to the chapter before.
    XCTAssertEqual(ChapterNav.previous(odd, landed), 0)
  }

  func testPreviousBeforeTheFirstChapterGoesToTheStart() {
    let late = [ch(0, 30, 600), ch(1, 630, 600)]
    XCTAssertEqual(ChapterNav.previous(late, 10), 0)
    XCTAssertEqual(ChapterNav.previous(late, 31), 0)
    XCTAssertEqual(ChapterNav.previous(late, 40), 30)
  }

  func testNowPlayingShowsTheChaptersTitleAndTimesWithinIt() {
    let t = NowPlayingTimes.of(chapters: chapters, position: 750, total: 1800, bookTitle: "Book")
    XCTAssertEqual(t, NowPlayingTimes(chapterIndex: 1, title: "Chapter 2", elapsed: 150, duration: 600))
  }

  func testNowPlayingRunsTheLastChapterToTheBooksEndWithoutAnEnd() {
    let open = [ch(0, 0, 600), Chapter(index: 1, title: " ", fileIndex: 0, filePath: "a.mp3", start: 600, end: 0,
                                       bookOffset: 600)]
    let t = NowPlayingTimes.of(chapters: open, position: 1000, total: 1800, bookTitle: "Book")
    XCTAssertEqual(t, NowPlayingTimes(chapterIndex: 1, title: "Part 2", elapsed: 400, duration: 1200))
  }

  func testNowPlayingWithoutChaptersIsTheWholeBook() {
    let t = NowPlayingTimes.of(chapters: [], position: 90, total: 1800, bookTitle: "Book")
    XCTAssertEqual(t, NowPlayingTimes(chapterIndex: nil, title: "Book", elapsed: 90, duration: 1800))
  }
}

final class ResumeTests: XCTestCase {
  let at = ISOTime.parse("2026-10-25T08:00:00.000Z")!

  func row(position: Double = 900, finished: Bool = false, version: Int = 5, device: String? = "phone",
           updatedAt: String = "2026-10-25T09:00:00.000Z") -> ProgressRow
  {
    ProgressRow(libraryId: 3, path: "Author/Book", position: position, duration: 1800, finished: finished,
                playbackSpeed: 1, version: version, deviceId: device, updatedAt: updatedAt)
  }

  func testWithNoPlaceHereTheServersRowIsTakenAndAcked() {
    let p = Resume.plan(local: nil, row: row(), deviceId: "watch", ackVersion: nil, total: 1800)
    XCTAssertEqual(p, ResumePlan(position: 900, file: nil, filePos: nil, start: .resume, unfinish: false, tookRow: true))
  }

  func testTheWatchsOwnPlaceStandsOverItsOwnRow() {
    let local = LocalPlace(position: 300, file: "a.mp3", filePos: 300, at: at)
    let p = Resume.plan(local: local, row: row(device: "watch"), deviceId: "watch", ackVersion: 2, total: 1800)
    XCTAssertEqual(p, ResumePlan(position: 300, file: "a.mp3", filePos: 300, start: .resume, unfinish: false, tookRow: false))
  }

  func testAnotherDevicesNewerPlaceAtAnUnseenVersionIsTaken() {
    let local = LocalPlace(position: 300, file: nil, filePos: nil, at: at)
    let p = Resume.plan(local: local, row: row(), deviceId: "watch", ackVersion: 4, total: 1800)
    XCTAssertEqual(p.position, 900)
    XCTAssertTrue(p.tookRow)
  }

  func testASeenVersionOrAnOlderRowLeavesThePlaceHere() {
    let local = LocalPlace(position: 300, file: nil, filePos: nil, at: at)
    let seen = Resume.plan(local: local, row: row(version: 4), deviceId: "watch", ackVersion: 4, total: 1800)
    XCTAssertEqual(seen.position, 300)
    let older = Resume.plan(local: local, row: row(updatedAt: "2026-10-25T07:00:00.000Z"), deviceId: "watch",
                            ackVersion: 1, total: 1800)
    XCTAssertEqual(older.position, 300)
    XCTAssertFalse(older.tookRow)
  }

  func testOfflineTheWatchsPlaceElseTheStart() {
    let local = LocalPlace(position: 300, file: nil, filePos: nil, at: at)
    XCTAssertEqual(Resume.plan(local: local, row: nil, deviceId: "watch", ackVersion: nil, total: 1800).position, 300)
    let fresh = Resume.plan(local: nil, row: nil, deviceId: "watch", ackVersion: nil, total: 1800)
    XCTAssertEqual(fresh, ResumePlan(position: 0, file: nil, filePos: nil, start: .resume, unfinish: false, tookRow: false))
  }

  func testAFinishedBookOrAPlaceAtTheEndStartsAgainWithUnfinishAndRestart() {
    let finished = Resume.plan(local: nil, row: row(position: 1800, finished: true), deviceId: "watch", ackVersion: nil,
                               total: 1800)
    XCTAssertEqual(finished, ResumePlan(position: 0, file: nil, filePos: nil, start: .restart, unfinish: true, tookRow: true))
    let local = LocalPlace(position: 1798, file: nil, filePos: nil, at: at)
    let end = Resume.plan(local: local, row: nil, deviceId: "watch", ackVersion: nil, total: 1800)
    XCTAssertEqual(end.start, .restart)
    XCTAssertEqual(end.position, 0)
  }

  func testAPlaceThatIsNotANumberIsTheStart() {
    let local = LocalPlace(position: .nan, file: "a.mp3", filePos: .nan, at: at)
    let p = Resume.plan(local: local, row: nil, deviceId: "watch", ackVersion: nil, total: 1800)
    XCTAssertEqual(p.position, 0)
    XCTAssertNil(p.file)
  }

  @MainActor
  func testThePlaceStoreKeepsANumberAndPersists() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent("places.json")
    let ref = BookRef(libraryId: 3, path: "Author/Book")
    let store = PlaceStore(url: url)
    store.set(ref, LocalPlace(position: 42, file: nil, filePos: nil, at: at))
    store.set(ref, LocalPlace(position: .nan, file: nil, filePos: nil, at: at))
    XCTAssertEqual(PlaceStore(url: url).place(ref)?.position, 42)
    store.clear()
    XCTAssertNil(PlaceStore(url: url).place(ref))
  }
}

final class SleepTimerTests: XCTestCase {
  let t0 = ISOTime.parse("2026-10-25T22:00:00.000Z")!

  func testADurationTimerCountsDownListeningOnly() {
    var t = SleepTimer.arm(.minutes(15), position: 0, rate: 1, chapters: chapters, total: 1800)
    XCTAssertEqual(t.left(position: 0, rate: 1), 900)
    t.played(600)
    XCTAssertFalse(t.due(position: 600))
    t.played(-5)
    t.played(.nan)
    XCTAssertEqual(t.remaining, 300)
    t.played(400)
    XCTAssertTrue(t.due(position: 1000))
    XCTAssertEqual(t.remaining, 0)
  }

  func testEndOfChapterStopsAtTheNextEndAtLeast30sAway() {
    let t = SleepTimer.arm(.endOfChapter, position: 100, rate: 1, chapters: chapters, total: 1800)
    XCTAssertEqual(t.stopAt, 600)
    XCTAssertEqual(t.left(position: 300, rate: 2), 150)
    XCTAssertFalse(t.due(position: 599))
    XCTAssertTrue(t.due(position: 599.6))
    // 20 s from a chapter end: the next one.
    XCTAssertEqual(SleepTimer.arm(.endOfChapter, position: 580, rate: 1, chapters: chapters, total: 1800).stopAt, 1200)
  }

  func testEndOfChapterWithNoChapterEndLeftAimsAtTheBooksEndElseFifteenMinutes() {
    XCTAssertEqual(SleepTimer.arm(.endOfChapter, position: 100, rate: 1, chapters: [], total: 1800).stopAt, 1800)
    let fallback = SleepTimer.arm(.endOfChapter, position: 1790, rate: 1, chapters: chapters, total: 1800)
    XCTAssertNil(fallback.stopAt)
    XCTAssertEqual(fallback.mode, .minutes(15))
    XCTAssertEqual(fallback.remaining, 900)
  }

  func testAShortPauseKeepsTheCountdownALongOneReArmsItAnAbandonedOneEndsIt() {
    var t = SleepTimer.arm(.minutes(30), position: 0, rate: 1, chapters: [], total: 1800)
    t.played(1200)
    t.paused(at: t0)
    XCTAssertEqual(t.resumed(at: t0.addingTimeInterval(5 * 60))?.remaining, 600)
    XCTAssertEqual(t.resumed(at: t0.addingTimeInterval(25 * 60))?.remaining, 1800)
    XCTAssertNil(t.resumed(at: t0.addingTimeInterval(3 * 3600)))
    XCTAssertNil(t.resumed(at: t0.addingTimeInterval(60))?.pausedAt)
  }

  func testAChapterTimerOutlivesAPause() {
    var t = SleepTimer.arm(.endOfChapter, position: 100, rate: 1, chapters: chapters, total: 1800)
    t.paused(at: t0)
    XCTAssertEqual(t.resumed(at: t0.addingTimeInterval(5 * 3600))?.stopAt, 600)
  }
}

final class AccountRulesTests: XCTestCase {
  func testAPairForAnotherAccountIsBlockedWhileEventsWaitUnlessDiscarded() {
    XCTAssertEqual(AccountRules.change(current: nil, incoming: "s.1", unsent: 3), .signIn)
    XCTAssertEqual(AccountRules.change(current: "s.1", incoming: "s.1", unsent: 3), .sameAccount)
    XCTAssertEqual(AccountRules.change(current: "s.1", incoming: "s.2", unsent: 3), .blocked(unsent: 3))
    XCTAssertEqual(AccountRules.change(current: "s.1", incoming: "s.2", unsent: 3, discard: true), .replace)
    XCTAssertEqual(AccountRules.change(current: "s.1", incoming: "t.1", unsent: 0), .replace)
  }

  func testSigningOutIsBlockedWhileEventsWaitUnlessDiscarded() {
    XCTAssertEqual(AccountRules.signOut(unsent: 2, discard: false), .blocked(unsent: 2))
    XCTAssertEqual(AccountRules.signOut(unsent: 2, discard: true), .allowed)
    XCTAssertEqual(AccountRules.signOut(unsent: 0, discard: false), .allowed)
  }
}

@MainActor
final class BackgroundSyncTests: XCTestCase {
  func testOnlyASuccessWithAnAnswerIsApplied() throws {
    let body = try Wire.encoder.encode(SyncResponse(serverTime: "2026-10-25T08:00:00Z", results: [], progress: nil))
    XCTAssertEqual(BackgroundSync.outcome(status: 200, body: body),
                   .answered(SyncResponse(serverTime: "2026-10-25T08:00:00Z", results: [], progress: nil)))
    XCTAssertEqual(BackgroundSync.outcome(status: nil, body: nil), .keep)
    XCTAssertEqual(BackgroundSync.outcome(status: 413, body: body), .keep)
    XCTAssertEqual(BackgroundSync.outcome(status: 401, body: body), .keep)
    XCTAssertEqual(BackgroundSync.outcome(status: 200, body: Data("<html>".utf8)), .keep)
  }

  func testTheTagRoundTripsAndAppliesOnlyToItsAccount() {
    let tag = SyncUploadTag(accountId: "s.1", ids: ["a", "b"])
    XCTAssertEqual(BackgroundSync.tag(BackgroundSync.describe(tag)), tag)
    XCTAssertNil(BackgroundSync.tag("not json", as: SyncUploadTag.self))
    XCTAssertTrue(BackgroundSync.applies(tag, accountId: "s.1"))
    XCTAssertFalse(BackgroundSync.applies(tag, accountId: "s.2"))
    XCTAssertFalse(BackgroundSync.applies(tag, accountId: nil))
    XCTAssertFalse(BackgroundSync.applies(SyncUploadTag(accountId: "s.1", ids: []), accountId: "s.1"))
  }

  func testABackgroundAnswerIsAppliedLikeAForegroundOne() async throws {
    let acks = AckStore(url: nil)
    let o = Outbox(directory: nil, acks: acks, deviceId: deviceId)
    o.append([listen("a"), listen("b"), listen("c")])
    let body = try XCTUnwrap(o.backgroundBody())
    XCTAssertNil(body.sentAt)
    // A foreground flush answered "c" meanwhile.
    o.apply(SyncResponse(serverTime: nil, results: [SyncResult(id: "c", status: "applied")], progress: nil),
            sent: o.events.filter { $0.id == "c" }, sentAt: nil, answeredAt: nil)
    let answer = SyncResponse(
      serverTime: "2026-10-25T08:00:00Z",
      results: [SyncResult(id: "a", status: "applied"), SyncResult(id: "b", status: "rejected", reason: "no_access"),
                SyncResult(id: "c", status: "duplicate")],
      progress: [row(version: 9)])
    var rows: [ProgressRow] = []
    o.onAnswer = { rows = $0 }
    o.applyBackground(answer, sentIds: body.events.map(\.id))
    XCTAssertTrue(o.events.isEmpty)
    XCTAssertEqual(o.couldNotSync().map(\.event.id), ["b"])
    XCTAssertEqual(o.couldNotSync().first?.reason, "no_access")
    XCTAssertEqual(acks.ackVersion(BookRef(libraryId: 3, path: "Author/Book")), 9)
    XCTAssertEqual(rows.map(\.version), [9])
    XCTAssertNil(o.state.clockSkewMs)
  }
}

final class DebugPairTests: XCTestCase {
  func testAPairMessageReadsFromJSONText() throws {
    let json = """
      {"v":1,"type":"pair","server_id":"srv","server_name":"Home","user_id":2,"user_name":"kode",
       "base_url":"http://192.168.1.5:8080","server_url":"http://192.168.1.5:8080","addresses":{},
       "pairing_token":"tok","expires_at":"2026-11-04T12:00:00Z","phone_name":"Simulator"}
      """
    guard case .pair(let p)? = PhoneMessages.decodeJSON(json) else { return XCTFail("not a pair") }
    XCTAssertEqual(p.accountId, "srv.2")
    XCTAssertEqual(p.baseURL, "http://192.168.1.5:8080")
    XCTAssertNil(PhoneMessages.decodeJSON("{"))
    XCTAssertNil(PhoneMessages.decodeJSON(#"{"v":2,"type":"pair"}"#))
  }
}
