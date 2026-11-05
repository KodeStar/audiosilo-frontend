// Ported from src/playback/store-listening.test.ts (the span lifecycle) and the event-building
// cases of src/playback/listening-outbox.test.ts (spanToEvent, a span is one event, timers that
// stood still), plus the base_version rules (BRIDGE-PLAN 2026-11-02: base_version on every span).
import XCTest

@testable import WatchCore

final class MemorySpanStore: OpenSpanStore {
  var stored: OpenSpan?
  var saves: [OpenSpan?] = []
  func load() -> OpenSpan? { stored }
  func save(_ span: OpenSpan?) {
    stored = span
    saves.append(span)
  }
}

final class Clock {
  var now: Date
  init(_ iso: String = "2026-10-25T07:00:00.000Z") { now = ISOTime.parse(iso)! }
  func advance(_ s: TimeInterval) { now = now.addingTimeInterval(s) }
}

let folder = BookRef(libraryId: 2, path: "A/Folder")
let book = PlayingBook(ref: folder, audioDuration: 100)

func at(_ pos: Double, _ file: String? = "A/Folder/1.mp3", _ filePos: Double? = nil) -> SpanEnd {
  SpanEnd(pos: pos, file: file, filePos: file == nil ? nil : (filePos ?? pos))
}

@MainActor
final class SpanRecorderTests: XCTestCase {
  var clock: Clock!
  var store: MemorySpanStore!
  var acks: AckStore!
  var emitted: [ListeningEvent] = []
  var ids = 0

  override func setUp() async throws {
    clock = Clock()
    store = MemorySpanStore()
    acks = AckStore(url: nil)
    emitted = []
    ids = 0
  }

  func recorder() -> SpanRecorder {
    SpanRecorder(store: store, acks: acks, clock: { [unowned self] in clock.now },
                 newId: { [unowned self] in ids += 1; return "e\(ids)" },
                 emit: { [unowned self] in emitted += $0 })
  }

  var listens: [SpanEvent] {
    emitted.compactMap { if case .listen(let e) = $0 { return e } else { return nil } }
  }

  var finishes: [FinishEvent] {
    emitted.compactMap { if case .finish(let e) = $0 { return e } else { return nil } }
  }

  // The stored span goes only once its event is kept: a kill between the two sends the span
  // twice under its one id (`duplicate`), the other way round it would be lost.
  func testTheStoredSpanStaysUntilItsEventIsKept() {
    var storedAtEmit: [OpenSpan?] = []
    let r = SpanRecorder(store: store, acks: acks, clock: { [unowned self] in clock.now }, newId: { "e" },
                         emit: { [unowned self] _ in storedAtEmit.append(store.stored) })
    r.open(book, at: at(5), speed: 1)
    clock.advance(10)
    r.close(at: at(15))
    XCTAssertNotNil(storedAtEmit[0])
    XCTAssertNil(store.stored)

    storedAtEmit = []
    store.stored = OpenSpan(libraryId: 2, path: "A/Folder", from: at(5), to: at(15), duration: 100, speed: 1,
                            startedAt: clock.now, endedAt: clock.now.addingTimeInterval(10), start: .resume,
                            baseVersion: 0, id: "left")
    let next = SpanRecorder(store: store, acks: acks, clock: { [unowned self] in clock.now }, newId: { "e" },
                            emit: { [unowned self] _ in storedAtEmit.append(store.stored) })
    next.recover()
    XCTAssertNotNil(storedAtEmit[0])
    XCTAssertNil(store.stored)
  }

  func testAPlayToAPauseIsOneSpanWithBothFilePlaces() {
    acks.ack(folder, version: 41)
    let r = recorder()
    r.open(book, at: at(5, "A/Folder/2.mp3", 5), speed: 1)
    clock.advance(55)
    r.close(at: at(60, "A/Folder/10.mp3", 10))
    XCTAssertEqual(listens.count, 1)
    let e = listens[0]
    XCTAssertEqual([e.fromPos, e.toPos], [5, 60])
    XCTAssertEqual(e.fromFile, "A/Folder/2.mp3")
    XCTAssertEqual(e.toFile, "A/Folder/10.mp3")
    XCTAssertEqual(e.toFilePos, 10)
    XCTAssertEqual(e.duration, 100)
    XCTAssertEqual(e.start, .resume)
    XCTAssertEqual(e.baseVersion, 41)
    XCTAssertEqual(e.startedAt, "2026-10-25T07:00:00.000Z")
    XCTAssertEqual(e.endedAt, "2026-10-25T07:00:55.000Z")
    XCTAssertNil(store.stored, "the close clears the stored span")
  }

  func testAStopNoticedLateEndsTheSpanWhenTheAudioStopped() {
    let r = recorder()
    r.open(book, at: at(5), speed: 1)
    let stopped = clock.now.addingTimeInterval(20)
    clock.advance(3600)  // the app was suspended; the system had paused the player
    r.close(at: at(25), stoppedAt: stopped)
    XCTAssertEqual(listens[0].endedAt, "2026-10-25T07:00:20.000Z")
    // Never after now, never before the start.
    r.open(book, at: at(25), speed: 1)
    r.close(at: at(26), stoppedAt: clock.now.addingTimeInterval(-7200))
    XCTAssertEqual(listens[1].endedAt, listens[1].startedAt)
    r.open(book, at: at(26), speed: 1)
    clock.advance(10)
    r.close(at: at(36), stoppedAt: clock.now.addingTimeInterval(60))
    XCTAssertEqual(ISOTime.parse(listens[2].endedAt), clock.now)
  }

  func testTheTickCutsWhileReachableAndTheNextContinues() {
    let r = recorder()
    r.open(book, at: at(5), speed: 1)
    clock.advance(15)
    r.tick(book, at: at(20), playing: true, reachable: true, speed: 1)
    clock.advance(10)
    r.close(at: at(30))
    XCTAssertEqual(listens.map { [$0.start.rawValue, "\($0.fromPos)", "\($0.toPos)"] },
                   [["resume", "5.0", "20.0"], ["continue", "20.0", "30.0"]])
  }

  func testOfflineTheTickKeepsTheSpanUntilAnHour() {
    let r = recorder()
    r.open(book, at: at(1), speed: 1)
    for i in 0..<(8 * 60 + 2) {
      clock.advance(15)
      r.tick(book, at: at(Double(2 + i)), playing: true, reachable: false, speed: 1)
    }
    XCTAssertEqual(listens.map(\.start), [.resume, .continue])
    for e in listens {
      let ms = ISOTime.parse(e.endedAt)!.timeIntervalSince(ISOTime.parse(e.startedAt)!)
      XCTAssertTrue(ms >= 3600 && ms < 3660, "\(ms)")
    }
    XCTAssertNotNil(r.span, "one still open")
  }

  func testASeekWhilePlayingEndsTheSpanWhereItWas() {
    let r = recorder()
    r.open(book, at: at(30), speed: 1)
    clock.advance(5)
    r.move(book, to: at(70), from: at(35), playing: true, speed: 1)
    clock.advance(5)
    r.move(book, to: at(10), from: at(75), playing: true, speed: 1)
    clock.advance(2)
    r.close(at: at(12))
    XCTAssertEqual(listens.map(\.start), [.resume, .jump, .movedBack])
    XCTAssertEqual(listens.map(\.fromPos), [30, 70, 10])
    XCTAssertEqual(listens.map(\.toPos), [35, 75, 12])
  }

  func testASeekWhilePausedSendsTheMoveAsASpanOfItsOwn() {
    acks.ack(folder, version: 41)
    let r = recorder()
    r.open(book, at: at(30), speed: 1)
    clock.advance(1)
    r.close(at: at(30))
    emitted = []
    r.move(book, to: at(80, "A/Folder/10.mp3", 30), from: nil, playing: false, speed: 1)
    XCTAssertEqual(listens.count, 1)
    XCTAssertEqual(listens[0].fromPos, 80)
    XCTAssertEqual(listens[0].toPos, 80)
    XCTAssertEqual(listens[0].toFile, "A/Folder/10.mp3")
    XCTAssertEqual(listens[0].toFilePos, 30)
    XCTAssertEqual(listens[0].start, .jump)
    XCTAssertEqual(listens[0].baseVersion, 41)
    // The next play begins with the same reason.
    r.open(book, at: at(80), speed: 1)
    XCTAssertEqual(r.span?.start, .jump)
  }

  func testAnExplicitZeroIsARestartAndAPlaceAJump() {
    let r = recorder()
    r.prepareStart(.restart)
    r.open(book, at: at(0), speed: 1)
    clock.advance(4)
    r.close(at: at(4))
    r.prepareStart(.jump)
    r.open(book, at: at(40), speed: 1)
    clock.advance(5)
    r.close(at: at(45))
    XCTAssertEqual(listens.map(\.start), [.restart, .jump])
  }

  func testAFinishedBookStartedAgainSendsUnfinishThenARestartSpan() {
    acks.ack(folder, version: 41)
    let r = recorder()
    r.prepareStart(.restart, unfinish: true)
    r.open(book, at: at(0.5), speed: 1)
    clock.advance(6)
    r.close(at: at(6))
    XCTAssertEqual(emitted.count, 2)
    guard case .finish(let un) = emitted[0] else { return XCTFail("unfinish first") }
    XCTAssertEqual(un.kind, "unfinish")
    XCTAssertEqual(un.baseVersion, 41)
    XCTAssertEqual(listens.map(\.start), [.restart])
    // Paused and played again: the unfinish went once.
    r.open(book, at: at(6), speed: 1)
    clock.advance(5)
    r.close(at: at(11))
    XCTAssertEqual(finishes.map(\.kind), ["unfinish"])
  }

  func testAnUnfinishOwedByABookThatNeverPlayedIsNotCarriedToTheNext() {
    let other = PlayingBook(ref: BookRef(libraryId: 2, path: "B/Other"), audioDuration: 100)
    let r = recorder()
    // A finished book loaded to start again, never played (the speaker declined), then another
    // book loaded and played.
    r.prepareStart(.restart, unfinish: true)
    r.prepareStart(.resume)
    r.open(other, at: at(30, "B/Other/1.mp3"), speed: 1)
    clock.advance(6)
    r.close(at: at(36, "B/Other/1.mp3"))
    XCTAssertEqual(finishes.count, 0)
    XCTAssertEqual(listens.map(\.start), [.resume])
  }

  func testTheNaturalEndClosesTheSpanThenSendsFinishOnce() {
    let r = recorder()
    r.open(book, at: at(45), speed: 1)
    clock.advance(5)
    r.finish(book, at: at(50))
    r.finish(book, at: nil)  // "mark finished" from the end screen
    XCTAssertEqual(listens.count, 1)
    XCTAssertEqual(finishes.map(\.kind), ["finish"])
    // Playing it again clears the mark.
    r.open(book, at: at(0), speed: 1)
    r.finish(book, at: at(0))
    XCTAssertEqual(finishes.count, 2)
  }

  func testAfterStayTheNextSpanBeginsAsAJump() {
    let r = recorder()
    r.standBy(book, at: nil, playing: false, speed: 1)
    r.open(book, at: at(5), speed: 1)
    clock.advance(4)
    r.close(at: at(9))
    XCTAssertEqual(listens.map(\.start), [.jump])
  }

  func testStayWhilePlayingCutsIntoAJump() {
    let r = recorder()
    r.open(book, at: at(5), speed: 1)
    clock.advance(4)
    r.standBy(book, at: at(9), playing: true, speed: 1)
    XCTAssertEqual(listens.map(\.start), [.resume])
    XCTAssertEqual(r.span?.start, .jump)
  }

  func testARateChangeCutsTheSpanAndTheNextRunsAtTheNewSpeed() {
    let r = recorder()
    r.open(book, at: at(5), speed: 1)
    clock.advance(10)
    r.cut(book, at: at(15), playing: true, speed: 1.5)
    clock.advance(10)
    r.close(at: at(30))
    XCTAssertNil(listens[0].playbackSpeed)
    XCTAssertEqual(listens[1].playbackSpeed, 1.5)
  }

  func testEmptySpansAreDroppedUnlessADeliberateMove() {
    let r = recorder()
    r.open(book, at: at(5), speed: 1)
    r.close(at: at(5))
    XCTAssertTrue(emitted.isEmpty)
    r.prepareStart(.jump)
    r.open(book, at: at(5), speed: 1)
    r.close(at: at(5))
    XCTAssertEqual(listens.map(\.start), [.jump])
  }

  // A stop right behind a move: its still event can come back `older` when sent apart from the
  // span before it, so the next span carries the move, as after a move made while paused.
  func testAMoveNothingWasHeardAfterGivesTheNextSpanItsReason() {
    let r = recorder()
    r.open(book, at: at(80), speed: 1)
    clock.advance(10)
    r.move(book, to: at(10), from: at(90), playing: true, speed: 1)
    r.close(at: at(10), stoppedAt: clock.now)
    XCTAssertEqual(listens.map(\.start), [.resume, .movedBack])
    XCTAssertEqual(r.nextStart, .movedBack)
    clock.advance(30)
    r.open(book, at: at(10), speed: 1)
    XCTAssertEqual(r.span?.start, .movedBack)
    XCTAssertEqual(r.nextStart, .resume, "taken once")
  }

  func testAMoveHeardForASecondSaysItAllItself() {
    let r = recorder()
    r.prepareStart(.jump)
    r.open(book, at: at(80), speed: 1)
    clock.advance(1)
    r.close(at: at(81))
    r.open(book, at: at(81), speed: 1)
    XCTAssertEqual(r.span?.start, .resume)
  }

  func testAnEmptySpanThatWasNoMoveLeavesTheNextSpanAlone() {
    let r = recorder()
    r.open(book, at: at(5), speed: 1)
    r.close(at: at(5))
    XCTAssertTrue(emitted.isEmpty)
    XCTAssertEqual(r.nextStart, .resume)
  }

  func testACutRightBehindAMoveKeepsTheMovesReason() {
    let r = recorder()
    r.prepareStart(.movedBack)
    r.open(book, at: at(10), speed: 1)
    r.cut(book, at: at(10), playing: true, speed: 1.5)
    XCTAssertEqual(r.span?.start, .movedBack)
    clock.advance(15)
    r.cut(book, at: at(25), playing: true, speed: 1.5)
    XCTAssertEqual(r.span?.start, .continue)
  }

  func testStayRightBehindAMoveIsStillAJump() {
    let r = recorder()
    r.prepareStart(.movedBack)
    r.open(book, at: at(10), speed: 1)
    r.standBy(book, at: at(10), playing: true, speed: 1)
    XCTAssertEqual(r.span?.start, .jump)
  }

  func testAnotherBooksMoveIsNotCarriedToTheBookOpening() {
    let r = recorder()
    r.prepareStart(.jump)
    r.open(book, at: at(10), speed: 1)
    let other = PlayingBook(ref: BookRef(libraryId: 2, path: "A/Other"), audioDuration: 50)
    r.open(other, at: at(1, "A/Other/1.mp3"), speed: 1)
    XCTAssertEqual(r.span?.path, "A/Other")
    XCTAssertEqual(r.span?.start, .resume)
    XCTAssertEqual(r.nextStart, .resume)
  }

  // Previous at the book's start, every press: not a move.
  func testAMoveToWhereThePlaceIsMovesNowhere() {
    XCTAssertTrue(Spans.movesNowhere(from: at(0), to: at(0)))
    XCTAssertTrue(Spans.movesNowhere(from: at(180.004), to: at(180)), "a seek lands a hair off")
    XCTAssertFalse(Spans.movesNowhere(from: at(0.5), to: at(0)))
    XCTAssertFalse(Spans.movesNowhere(from: nil, to: at(0)))
    XCTAssertFalse(Spans.movesNowhere(from: at(0), to: nil))
    XCTAssertFalse(Spans.movesNowhere(from: at(.nan), to: at(0)))
  }

  // The open span is kept every 5 s.
  func testTheKeepStoresTheSpanUpToWhereTheEngineIs() {
    let r = recorder()
    r.open(book, at: at(1), speed: 1)
    clock.advance(5)
    r.keep(at: at(6))
    XCTAssertEqual(store.stored?.to.pos, 6)
    XCTAssertEqual(store.stored?.id, "e1", "the id is fixed at open")
  }

  func testTheKeepNeverMovesTheSpanBack() {
    let r = recorder()
    r.open(book, at: at(1), speed: 1)
    clock.advance(5)
    r.keep(at: at(6))
    clock.advance(5)
    r.keep(at: at(2))
    XCTAssertEqual(store.stored?.to.pos, 6)
  }

  func testASpanAKillLeftIsClosedAtTheNextLaunchOnce() {
    let r = recorder()
    r.open(book, at: at(1), speed: 1)
    clock.advance(5)
    r.keep(at: at(6))
    // A kill: a new launch, the same store.
    emitted = []
    let next = recorder()
    next.recover()
    next.recover()
    XCTAssertEqual(listens.count, 1)
    XCTAssertEqual(listens[0].id, "e1")
    XCTAssertEqual(listens[0].toPos, 6)
    XCTAssertNil(store.stored)
  }

  func testTheFirstOpenRecoversFirst() {
    store.stored = OpenSpan(libraryId: 2, path: "A/Folder", from: at(1), to: at(20), duration: 100, speed: 1,
                            startedAt: clock.now.addingTimeInterval(-60), endedAt: clock.now.addingTimeInterval(-40),
                            start: .resume, baseVersion: 3, id: "left")
    let r = recorder()
    r.open(book, at: at(20), speed: 1)
    XCTAssertEqual(listens.map(\.id), ["left"])
  }

  // base_version on every span: the acknowledged version at close, never below the one it
  // opened on, 0 on a cold start.
  func testBaseVersionIsZeroOnAColdStart() {
    let r = recorder()
    r.open(book, at: at(1), speed: 1)
    clock.advance(5)
    r.close(at: at(6))
    XCTAssertEqual(listens[0].baseVersion, 0)
  }

  func testBaseVersionIsTheAckAtCloseNeverLower() {
    acks.ack(folder, version: 41)
    let r = recorder()
    r.open(book, at: at(1), speed: 1)
    acks.ack(folder, version: 44)  // an answer acknowledged while it played
    clock.advance(5)
    r.close(at: at(6))
    XCTAssertEqual(listens[0].baseVersion, 44)
    acks.ack(folder, version: 40)  // never lowers
    XCTAssertEqual(acks.ackVersion(folder), 44)
  }
}

final class SpanEventTests: XCTestCase {
  func span(_ change: (inout OpenSpan) -> Void = { _ in }) -> OpenSpan {
    var s = OpenSpan(
      libraryId: 3, path: "Author/Book", from: SpanEnd(pos: 14400, file: "Author/Book/04.mp3", filePos: 812.4),
      to: SpanEnd(pos: 16800, file: "Author/Book/05.mp3", filePos: 1203.9), duration: 61200, speed: 1.2,
      startedAt: ISOTime.parse("2026-10-25T07:00:12.000Z")!, endedAt: ISOTime.parse("2026-10-25T07:33:30.000Z")!,
      start: .resume, baseVersion: 41, id: "e1")
    change(&s)
    return s
  }

  func testSendsBothEndsTheFingerprintTheSpeedAndTheBase() throws {
    let json = try JSONSerialization.jsonObject(with: Wire.encoder.encode(ListeningEvent.listen(Spans.event(span())))) as! [String: Any]
    XCTAssertEqual(json as NSDictionary, [
      "id": "e1", "kind": "listen", "library_id": 3, "path": "Author/Book", "from_pos": 14400, "to_pos": 16800,
      "from_file": "Author/Book/04.mp3", "from_file_pos": 812.4, "to_file": "Author/Book/05.mp3",
      "to_file_pos": 1203.9, "duration": 61200, "playback_speed": 1.2, "started_at": "2026-10-25T07:00:12.000Z",
      "ended_at": "2026-10-25T07:33:30.000Z", "start": "resume", "base_version": 41,
    ] as NSDictionary)
  }

  func testLeavesOutAHalfPairSpeedOneUnknownLengthAndBase() throws {
    let e = Spans.event(span {
      $0.from = SpanEnd(pos: 10)
      $0.to = SpanEnd(pos: 20, file: "x.mp3")
      $0.speed = 1
      $0.duration = 0
      $0.baseVersion = nil
    })
    let json = try JSONSerialization.jsonObject(with: Wire.encoder.encode(e)) as! [String: Any]
    for key in ["from_file", "to_file", "playback_speed", "duration", "base_version"] {
      XCTAssertNil(json[key], key)
    }
  }

  func testIdsAreWhatTheServerTakes() {
    let id = UUID().uuidString
    XCTAssertNotNil(id.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression))
  }

  func testASpanThatMovedNowhereSaysNothingUnlessADeliberateMove() {
    let still: (inout OpenSpan) -> Void = {
      $0.endedAt = $0.startedAt
      $0.to = $0.from
    }
    XCTAssertFalse(Spans.saysSomething(span(still)))
    XCTAssertFalse(Spans.saysSomething(span { still(&$0); $0.start = .continue }))
    XCTAssertTrue(Spans.saysSomething(span { still(&$0); $0.start = .jump }))
    XCTAssertTrue(Spans.saysSomething(span { still(&$0); $0.start = .restart }))
    XCTAssertTrue(Spans.saysSomething(span()))
  }

  func testNeverClaimsMoreThanTheMaximumWallClock() {
    // Timers that stood still: a span open three days.
    let e = Spans.event(span {
      $0.endedAt = $0.startedAt.addingTimeInterval(3 * 24 * 3600)
      $0.from.pos = 0
      $0.to.pos = 600
      $0.speed = 2
    })
    let wall = ISOTime.parse(e.endedAt)!.timeIntervalSince(ISOTime.parse(e.startedAt)!)
    XCTAssertEqual(wall, 300, accuracy: 0.001, "the audio it covered at 2x")
    let long = Spans.event(span {
      $0.endedAt = $0.startedAt.addingTimeInterval(3 * 24 * 3600)
      $0.from.pos = 0
      $0.to.pos = 200_000
    })
    let w2 = ISOTime.parse(long.endedAt)!.timeIntervalSince(ISOTime.parse(long.startedAt)!)
    XCTAssertEqual(w2, Spans.MAX_EVENT_SPAN, accuracy: 0.001)
  }

  // listening-outbox.test.ts "a place that is not a number is never enqueued".
  func testANumberThatIsNotOneIsNotFinite() {
    XCTAssertFalse(ListeningEvent.listen(Spans.event(span { $0.to.pos = .nan })).isFinite)
    var e = Spans.event(span())
    e.toFilePos = .infinity
    XCTAssertFalse(ListeningEvent.listen(e).isFinite)
    XCTAssertTrue(ListeningEvent.listen(Spans.event(span())).isFinite)
  }
}
