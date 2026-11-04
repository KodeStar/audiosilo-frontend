// Ported from src/playback/listening-outbox.test.ts (flushOutbox, giving up, the server clock,
// keptMine) and src/playback/place-reconcile.test.ts (offerOf, OFFER_REPEAT_MS).
import XCTest

@testable import WatchCore

let deviceId = "watch-device"

func listen(_ id: String, endedAt: String = "2026-10-25T07:33:30.000Z", lib: Int = 3, path: String = "Author/Book")
  -> ListeningEvent
{
  .listen(SpanEvent(id: id, libraryId: lib, path: path, fromPos: 14400, toPos: 16800, duration: 61200,
                    startedAt: "2026-10-25T07:00:12.000Z", endedAt: endedAt, start: .resume, baseVersion: 41))
}

/// A transport that answers with `respond` and records every body it was sent.
final class FakeTransport: ListeningSyncTransport {
  var bodies: [SyncRequest] = []
  var respond: (SyncRequest) throws -> SyncResponse

  init(_ respond: @escaping (SyncRequest) throws -> SyncResponse = { answer($0) }) { self.respond = respond }

  func syncListening(_ request: SyncRequest) async throws -> SyncResponse {
    bodies.append(request)
    return try respond(request)
  }
}

struct NoAnswer: Error {}

func answer(_ body: SyncRequest, serverTime: String = "2026-10-25T07:41:03.480Z",
            status: (ListeningEvent) -> SyncResult? = { _ in nil }, progress: [ProgressRow] = []) -> SyncResponse
{
  SyncResponse(serverTime: serverTime,
               results: body.events.map { status($0) ?? SyncResult(id: $0.id, status: "applied") },
               progress: progress)
}

func row(lib: Int = 3, path: String = "Author/Book", version: Int, device: String? = deviceId) -> ProgressRow {
  ProgressRow(libraryId: lib, path: path, position: 16800, duration: 61200, finished: false, playbackSpeed: 1,
           version: version, deviceId: device, updatedAt: "2026-10-25T07:33:30.000Z")
}

@MainActor
final class OutboxTests: XCTestCase {
  var clock: Clock!
  var acks: AckStore!

  override func setUp() async throws {
    clock = Clock("2026-10-25T08:00:00.000Z")
    acks = AckStore(url: nil)
  }

  func outbox(_ dir: URL? = nil) -> Outbox {
    Outbox(directory: dir, acks: acks, deviceId: deviceId, clock: { [unowned self] in clock.now })
  }

  func testSendsAFreshSentAtPerAttemptAndTheDeviceId() async {
    let o = outbox()
    o.append([listen("a")])
    var fail = true
    let t = FakeTransport { if fail { throw NoAnswer() }; return answer($0) }
    await o.flush(via: t)
    XCTAssertTrue(o.lastFlushFailed)
    clock.now = ISOTime.parse("2026-10-25T09:30:00.000Z")!
    fail = false
    await o.flush(via: t)
    XCTAssertEqual(t.bodies.map(\.sentAt), ["2026-10-25T08:00:00.000Z", "2026-10-25T09:30:00.000Z"])
    XCTAssertEqual(t.bodies[1].deviceId, deviceId)
    XCTAssertNil(t.bodies[1].clockOffset)
    XCTAssertTrue(o.events.isEmpty)
  }

  func testKeepsEverythingOnNoAnswerAnd401403404And5xx() async {
    let o = outbox()
    o.append([listen("a")])
    await o.flush(via: FakeTransport { _ in throw NoAnswer() })
    for status in [401, 403, 404, 405, 500, 503] {
      await o.flush(via: FakeTransport { _ in throw APIError(status: status) })
    }
    XCTAssertEqual(o.events.map(\.id), ["a"])
    XCTAssertTrue(o.couldNotSync().isEmpty)
  }

  func testSendsInChunksOf200RoundAfterRound() async {
    let o = outbox()
    o.append((0..<450).map { listen("e\($0)") })
    let t = FakeTransport()
    await o.flush(via: t)
    XCTAssertEqual(t.bodies.map(\.events.count), [200, 200, 50])
    XCTAssertEqual(t.bodies[1].events[0].id, "e200")
    XCTAssertTrue(o.events.isEmpty)
  }

  func testHalvesTheChunkOnA413OrTooManyEvents() async {
    let o = outbox()
    o.append((0..<300).map { listen("e\($0)") })
    var calls = 0
    let t = FakeTransport { body in
      calls += 1
      if calls == 1 { throw APIError(status: 413) }
      if calls == 2 { throw APIError(status: 400, code: "too_many_events") }
      return answer(body)
    }
    await o.flush(via: t)
    XCTAssertEqual(t.bodies.map(\.events.count), [200, 100, 50, 50, 50, 50, 50, 50])
    XCTAssertTrue(o.events.isEmpty)
  }

  func testA400OnABatchResendsOneByOneOnce() async {
    let o = outbox()
    o.append([listen("good"), listen("bad"), listen("also-good")])
    let t = FakeTransport { body in
      if body.events.count > 1 || body.events[0].id == "bad" { throw APIError(status: 400, message: "invalid request") }
      return answer(body)
    }
    await o.flush(via: t)
    XCTAssertEqual(t.bodies.map { $0.events.map(\.id) }, [["good", "bad", "also-good"], ["good"], ["bad"], ["also-good"]])
    XCTAssertTrue(o.events.isEmpty)
    XCTAssertEqual(o.couldNotSync().map { [$0.event.id, $0.reason] }, [["bad", "invalid"]])
  }

  func testEveryStatusButRejectedRemovesTheEvent() async {
    let statuses: [String: SyncResult] = [
      "a": SyncResult(id: "a", status: "applied"), "b": SyncResult(id: "b", status: "duplicate"),
      "c": SyncResult(id: "c", status: "diverged", kept: "stored"),
      "d": SyncResult(id: "d", status: "not_applied", reason: "resume_behind"),
      "e": SyncResult(id: "e", status: "rejected", reason: "duration_mismatch"),
    ]
    let o = outbox()
    o.append(["a", "b", "c", "d", "e"].map { listen($0) })
    await o.flush(via: FakeTransport { answer($0, status: { statuses[$0.id] }) })
    XCTAssertTrue(o.events.isEmpty)
    XCTAssertEqual(o.couldNotSync().map { [$0.event.id, $0.reason] }, [["e", "duration_mismatch"]])
    XCTAssertEqual(o.state.lastSyncAt, clock.now)
    o.discardFailed("e")
    XCTAssertTrue(o.couldNotSync().isEmpty)
  }

  func testAnEventWithNoResultWaitsForALaterTry() async {
    let o = outbox()
    o.append([listen("a"), listen("b")])
    await o.flush(via: FakeTransport { body in
      SyncResponse(serverTime: nil, results: [SyncResult(id: "a", status: "applied")], progress: nil)
    })
    XCTAssertEqual(o.events.map(\.id), ["b"])
  }

  func testKeepsTheNewestHundredOnTheCouldntSyncList() async {
    let count = Outbox.MAX_COULD_NOT_SYNC + 50
    let o = outbox()
    o.append((0..<count).map { listen("r\($0)") })
    await o.flush(via: FakeTransport { answer($0, status: { SyncResult(id: $0.id, status: "rejected", reason: "not_found") }) })
    XCTAssertEqual(o.couldNotSync().count, Outbox.MAX_COULD_NOT_SYNC)
    XCTAssertEqual(o.couldNotSync().last?.event.id, "r\(count - 1)")
    XCTAssertTrue(o.events.isEmpty)
  }

  func testKeepsACouldntSyncEntryThirtyDays() async {
    let o = outbox()
    o.append([listen("big")])
    await o.flush(via: FakeTransport { _ in throw APIError(status: 413) })
    XCTAssertEqual(o.couldNotSync().map { [$0.event.id, $0.reason] }, [["big", "too_large"]])
    XCTAssertEqual(o.couldNotSync(now: clock.now.addingTimeInterval(1)).count, 1)
    XCTAssertEqual(o.couldNotSync(now: clock.now.addingTimeInterval(Outbox.COULD_NOT_SYNC_KEEP)).count, 0)
  }

  func testGivesUpAnEventOlderThan89DaysUnsent() async {
    let old = ISOTime.string(clock.now.addingTimeInterval(-Outbox.GIVE_UP_AGE - 60))
    let o = outbox()
    o.append([
      listen("old", endedAt: old),
      .finish(FinishEvent(id: "old-finish", kind: "finish", libraryId: 3, path: "Author/Book", at: old)),
      listen("new", endedAt: ISOTime.string(clock.now)),
    ])
    let t = FakeTransport()
    await o.flush(via: t)
    XCTAssertEqual(t.bodies.flatMap { $0.events.map(\.id) }, ["new"])
    XCTAssertEqual(o.couldNotSync().map { [$0.event.id, $0.reason] }, [["old", "too_old"], ["old-finish", "too_old"]])
    XCTAssertTrue(o.events.isEmpty)
  }

  func testAcknowledgesARowThatKeptThisDevicesEvent() async {
    let o = outbox()
    o.append([listen("a")])
    var rows: [ProgressRow] = []
    o.onAnswer = { rows = $0 }
    await o.flush(via: FakeTransport { answer($0, progress: [row(version: 42)]) })
    XCTAssertEqual(acks.ackVersion(BookRef(libraryId: 3, path: "Author/Book")), 42)
    XCTAssertEqual(rows.map(\.version), [42])
  }

  func testAcknowledgesTheRowAnUnfinishHandsThisDevice() async {
    let o = outbox()
    o.append([.finish(FinishEvent(id: "u", kind: "unfinish", libraryId: 3, path: "Author/Book", at: "2026-10-25T08:00:00.000Z", baseVersion: 9))])
    await o.flush(via: FakeTransport { answer($0, progress: [row(version: 10)]) })
    XCTAssertEqual(acks.ackVersion(BookRef(libraryId: 3, path: "Author/Book")), 10)
  }

  func testDoesNotAcknowledgeAnotherDevicesRow() async {
    let o = outbox()
    o.append([listen("a")])
    await o.flush(via: FakeTransport { answer($0, progress: [row(version: 42, device: "phone")]) })
    XCTAssertNil(acks.ackVersion(BookRef(libraryId: 3, path: "Author/Book")))
  }

  func testOneFlushInFlightACallMeanwhileGoesRoundAgain() async {
    let o = outbox()
    o.append([listen("a")])
    var second: Task<Void, Never>?
    let t = FakeTransport()
    t.respond = { body in
      if second == nil {
        o.append([listen("b")])
        second = Task { @MainActor in await o.flush(via: t) }
      }
      return answer(body)
    }
    await o.flush(via: t)
    await second?.value
    XCTAssertEqual(t.bodies.map { $0.events.map(\.id) }, [["a"], ["b"]])
    XCTAssertTrue(o.events.isEmpty)
  }

  func testTheServerClockIsMeasuredAndKept() async {
    let o = outbox()
    o.append([listen("a")])
    await o.flush(via: FakeTransport { answer($0, serverTime: "2026-10-25T08:00:30.000Z") })
    XCTAssertEqual(o.state.clockSkewMs, 30_000)
  }

  func testDropsAnEventThatIsNotFiniteAndADuplicateId() {
    let o = outbox()
    var bad = SpanEvent(id: "nan", libraryId: 3, path: "p", fromPos: .nan, toPos: 1, startedAt: "x", endedAt: "x", start: .resume)
    bad.toPos = 1
    o.append([.listen(bad), listen("a"), listen("a")])
    XCTAssertEqual(o.events.map(\.id), ["a"])
  }

  func testPersistsAcrossLaunches() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let o = outbox(dir)
    o.append([listen("a"), listen("b")])
    await o.flush(via: FakeTransport { answer($0, status: { $0.id == "b" ? SyncResult(id: "b", status: "rejected", reason: "not_found") : SyncResult(id: $0.id, status: "duplicate") }) })
    o.append([listen("c")])
    let again = outbox(dir)
    XCTAssertEqual(again.events.map(\.id), ["c"])
    XCTAssertEqual(again.couldNotSync().map(\.event.id), ["b"])
    again.discardAll()
    XCTAssertEqual(outbox(dir).unsentCount, 0)
  }

  // The background upload (decision 10): a body built now carries clock_offset, not sent_at.
  func testTheBackgroundBodyCarriesTheLastSkewAsClockOffset() async {
    let o = outbox()
    XCTAssertNil(o.backgroundBody())
    o.append([listen("a")])
    await o.flush(via: FakeTransport { answer($0, serverTime: "2026-10-25T08:00:12.500Z") })
    o.append([listen("b"), listen("c")])
    let body = o.backgroundBody()
    XCTAssertNil(body?.sentAt)
    XCTAssertEqual(body?.clockOffset, 12.5)
    XCTAssertEqual(body?.events.map(\.id), ["b", "c"])
    // Its answer, applied on wake; one a foreground send took meanwhile is skipped.
    o.applyBackground(SyncResponse(serverTime: nil, results: [SyncResult(id: "b", status: "applied"), SyncResult(id: "c", status: "duplicate")], progress: nil), sentIds: ["b", "c", "gone"])
    XCTAssertTrue(o.events.isEmpty)
    XCTAssertEqual(o.state.clockSkewMs, 12_500, "no skew from a request whose times are unknown")
  }

  func testTheBodyEncodesExactlyOneClock() throws {
    let fg = SyncRequest(deviceId: "d", sentAt: "2026-10-25T08:00:00.000Z", clockOffset: nil, events: [])
    let bg = SyncRequest(deviceId: "d", sentAt: nil, clockOffset: -3, events: [])
    let a = try JSONSerialization.jsonObject(with: Wire.encoder.encode(fg)) as! [String: Any]
    let b = try JSONSerialization.jsonObject(with: Wire.encoder.encode(bg)) as! [String: Any]
    XCTAssertEqual(Set(a.keys), ["device_id", "sent_at", "events"])
    XCTAssertEqual(Set(b.keys), ["device_id", "clock_offset", "events"])
  }
}

final class ClockSkewTests: XCTestCase {
  func testMeasuresFromTheMiddleOfTheRequest() {
    let sentAt = ISOTime.parse("2026-10-25T07:41:00.000Z")!
    XCTAssertEqual(ClockSkew.of(serverTime: "2026-10-25T07:41:21.000Z", sentAt: sentAt, answeredAt: sentAt.addingTimeInterval(2)), 20_000)
    XCTAssertNil(ClockSkew.of(serverTime: "not a time", sentAt: sentAt, answeredAt: sentAt))
    XCTAssertNil(ClockSkew.of(serverTime: nil, sentAt: sentAt, answeredAt: sentAt))
  }

  func testReadsTheServersNanosecondTimes() {
    let a = ISOTime.parse("2026-10-25T07:41:21.123456789Z")!
    XCTAssertEqual(a.timeIntervalSince1970, ISOTime.parse("2026-10-25T07:41:21Z")!.timeIntervalSince1970 + 0.123456789, accuracy: 1e-6)
    XCTAssertEqual(ISOTime.parse("2026-10-25T08:41:21+01:00"), ISOTime.parse("2026-10-25T07:41:21.000Z"))
  }

  func testTheClockOffsetIsSecondsAndZeroWhenUnknown() {
    XCTAssertEqual(ClockSkew.clockOffset(skewMs: 1500), 1.5)
    XCTAssertEqual(ClockSkew.clockOffset(skewMs: nil), 0)
    XCTAssertEqual(ClockSkew.clockOffset(skewMs: .nan), 0)
  }
}

@MainActor
final class AckAndOfferTests: XCTestCase {
  let ref = BookRef(libraryId: 3, path: "Author/Book")

  func testKeptMineAcknowledgesOnlyThisDevicesRowThatKeptItsEvent() {
    let events = [listen("a")]
    func results(_ status: String, kept: String? = nil) -> [String: SyncResult] {
      ["a": SyncResult(id: "a", status: status, kept: kept)]
    }
    let mine = row(version: 1, device: "me")
    XCTAssertTrue(AckRules.keptMine(mine, deviceId: "me", sent: events, results: results("applied")))
    XCTAssertTrue(AckRules.keptMine(mine, deviceId: "me", sent: events, results: results("diverged", kept: "event")))
    XCTAssertFalse(AckRules.keptMine(mine, deviceId: "me", sent: events, results: results("diverged", kept: "stored")))
    XCTAssertFalse(AckRules.keptMine(mine, deviceId: "me", sent: events, results: results("not_applied")))
    XCTAssertFalse(AckRules.keptMine(row(version: 1, device: "other"), deviceId: "me", sent: events, results: results("applied")))
    XCTAssertFalse(AckRules.keptMine(row(path: "Else", version: 1, device: "me"), deviceId: "me", sent: events, results: results("applied")))
  }

  func testAckNeverLowersAndResumeAcksAVersionAboveZero() {
    let acks = AckStore(url: nil)
    XCTAssertNil(acks.ackVersion(ref))
    acks.ackResume(row(version: 0))
    XCTAssertNil(acks.ackVersion(ref), "a cold start stays 0")
    acks.ackResume(row(version: 9))
    acks.ack(ref, version: 5)
    XCTAssertEqual(acks.ackVersion(ref), 9)
  }

  func testAnsweringAnOfferAcksTheRowAndNotesTheKey() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent("acks.json")
    let acks = AckStore(url: url)
    acks.ack(ref, version: 12)
    acks.answerOffer(ref, row: row(version: 7), key: "k1")
    XCTAssertEqual(acks.ackVersion(ref), 12, "never lowered")
    for i in 0..<30 { acks.answerOffer(ref, row: row(version: 13), key: "k\(i)") }
    let reread = AckStore(url: url)
    XCTAssertEqual(reread.ackVersion(ref), 13)
    XCTAssertEqual(reread.answered(ref).count, AckStore.MAX_ANSWERED)
    XCTAssertEqual(reread.answered(ref).last, "k29")
  }

  func progressRow(position: Double = 400, finished: Bool = false, version: Int = 3, device: String = "other-device",
              name: String? = nil, other: OtherPlace? = nil) -> ProgressRow
  {
    ProgressRow(libraryId: 2, path: "A/Book.m4b", position: position, duration: 1000, finished: finished, playbackSpeed: 1,
             version: version, deviceId: device, updatedAt: "2026-10-08T10:00:00Z", deviceName: name, otherPlace: other)
  }

  let other = OtherPlace(position: 900, deviceId: "watch", deviceName: "Chris's Watch", updatedAt: "2026-10-08T11:00:00Z")

  func testOffersTheKeptRowOfAnotherDeviceAtAnUnseenVersion() {
    XCTAssertEqual(Offers.offerOf(progressRow(version: 4, name: "Pixel"), deviceId: "this-device", ackVersion: 3, enginePosition: 105),
                   PlaceOffer(position: 400, deviceName: "Pixel", key: "other-device|2026-10-08T10:00:00Z"))
    XCTAssertNil(Offers.offerOf(progressRow(version: 3), deviceId: "this-device", ackVersion: 3, enginePosition: 105))
    XCTAssertNil(Offers.offerOf(progressRow(device: "this-device"), deviceId: "this-device", ackVersion: 0, enginePosition: 105))
    XCTAssertNil(Offers.offerOf(progressRow(finished: true), deviceId: "this-device", ackVersion: 0, enginePosition: 105))
    XCTAssertNil(Offers.offerOf(progressRow(), deviceId: "this-device", ackVersion: 0, enginePosition: 371))
    XCTAssertEqual(Offers.offerOf(progressRow(), deviceId: "this-device", ackVersion: 0, enginePosition: 369)?.position, 400)
    XCTAssertEqual(Offers.offerOf(progressRow(), deviceId: "this-device", ackVersion: nil, enginePosition: 105)?.deviceName, "")
  }

  func testElseTheRowsOtherPlaceUntilAnswered() {
    let r = progressRow(device: "this-device", other: other)
    XCTAssertEqual(Offers.offerOf(r, deviceId: "this-device", ackVersion: 3, enginePosition: 400),
                   PlaceOffer(position: 900, deviceName: "Chris's Watch", key: "watch|2026-10-08T11:00:00Z"))
    XCTAssertNil(Offers.offerOf(r, deviceId: "this-device", ackVersion: 3, enginePosition: 400, answered: ["watch|2026-10-08T11:00:00Z"]))
    var mine = other
    mine.deviceId = "this-device"
    XCTAssertNil(Offers.offerOf(progressRow(device: "this-device", other: mine), deviceId: "this-device", ackVersion: 3, enginePosition: 400))
    XCTAssertNil(Offers.offerOf(r, deviceId: "this-device", ackVersion: 3, enginePosition: 880))
    let both = progressRow(version: 9, other: other)
    XCTAssertEqual(Offers.offerOf(both, deviceId: "this-device", ackVersion: 3, enginePosition: 105)?.position, 400)
    XCTAssertEqual(Offers.offerOf(both, deviceId: "this-device", ackVersion: 3, enginePosition: 105, answered: ["other-device|2026-10-08T10:00:00Z"])?.position, 900)
    XCTAssertNil(Offers.offerOf(nil, deviceId: "this-device", ackVersion: 3, enginePosition: 105))
  }

  func testADevicePlayingOnIsOfferedOnceInTenMinutes() {
    let throttle = OfferThrottle()
    let t0 = Date()
    let first = PlaceOffer(position: 800, deviceName: "Tablet", key: "tablet|2026-10-08T11:50:00Z")
    XCTAssertTrue(throttle.shouldShow(first, for: ref, now: t0))
    XCTAssertFalse(throttle.shouldShow(first, for: ref, now: t0.addingTimeInterval(Offers.OFFER_REPEAT * 2)), "each offer once per launch")
    let next = PlaceOffer(position: 815, deviceName: "Tablet", key: "tablet|2026-10-08T11:50:15Z")
    XCTAssertFalse(throttle.shouldShow(next, for: ref, now: t0.addingTimeInterval(15)))
    let later = PlaceOffer(position: 900, deviceName: "Tablet", key: "tablet|2026-10-08T12:00:15Z")
    XCTAssertTrue(throttle.shouldShow(later, for: ref, now: t0.addingTimeInterval(Offers.OFFER_REPEAT)))
    XCTAssertTrue(throttle.shouldShow(next, for: BookRef(libraryId: 9, path: "other"), now: t0), "per book")
  }
}
