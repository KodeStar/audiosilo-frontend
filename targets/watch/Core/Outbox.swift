// The watch's listening outbox (Sync v2), a port of the sending half of the phone's
// `src/playback/listening-outbox.ts` (CROSS-REPO section 25). One account per watch, so one
// outbox: events wait here, append-only and immutable, until the server answers for them
// (`POST /me/listening/sync`).
//
// Sending (`flush`): one request in flight, chunks of 200, `sent_at` set per attempt. Every
// status but `rejected` removes the event; `rejected` moves it to the couldn't-sync list (30
// days, at most 100). No answer (offline), 401, 403, 404/405 and 5xx keep everything (the watch
// has no PUT fallback: the server gate up front, decision 5). A 413 or `too_many_events` halves
// the chunk, and one event alone still 413 is listed `too_large`; a 400 on a batch sends its
// events one by one once, and one refused alone is listed `invalid`. Before sending, an event
// older than 89 days is listed `too_old` unsent.
import Foundation

/// An event the server would not take, kept to show (the couldn't-sync list).
struct CouldNotSync: Codable, Equatable, Sendable {
  var event: ListeningEvent
  var reason: String
  var at: Date
}

/// What Sync status shows, and the server's clock skew.
struct SyncState: Codable, Equatable, Sendable {
  var lastSyncAt: Date?
  var failed: [CouldNotSync] = []
  /// How far ahead of the watch's clock the server's was at the last answer (ms).
  var clockSkewMs: Double?
}

/// Sends one batch. `APIClient` in the app; a fake in the tests. Throws `APIError` for a
/// server's own answer, anything else for no answer.
protocol ListeningSyncTransport {
  func syncListening(_ request: SyncRequest) async throws -> SyncResponse
}

@MainActor
final class Outbox {
  static let MAX_CHUNK = 200
  static let COULD_NOT_SYNC_KEEP: TimeInterval = 30 * 24 * 3600
  static let MAX_COULD_NOT_SYNC = 100
  static let GIVE_UP_AGE: TimeInterval = 89 * 24 * 3600
  /// How many rounds one flush makes at most.
  static let MAX_ROUNDS = 50

  private let eventsFile: JSONFile<[ListeningEvent]>?
  private let stateFile: JSONFile<SyncState>?
  private let acks: AckStore
  private let deviceId: String
  private let clock: () -> Date

  private(set) var events: [ListeningEvent]
  private(set) var state: SyncState
  /// The last flush ended without an answer (offline, or the server failed).
  private(set) var lastFlushFailed = false

  private var chunkSize = Outbox.MAX_CHUNK
  private var running: Task<Void, Never>?
  private var again = false

  /// Told of every answer's progress rows (the offer check, pass 2).
  var onAnswer: (([ProgressRow]) -> Void)?
  /// Told whenever the events or the state change (watch-state, Sync status).
  var onChange: (() -> Void)?

  /// `directory` nil keeps everything in memory (tests).
  init(directory: URL?, acks: AckStore, deviceId: String, clock: @escaping () -> Date = Date.init) {
    eventsFile = directory.map { JSONFile(url: $0.appendingPathComponent("outbox.json")) }
    stateFile = directory.map { JSONFile(url: $0.appendingPathComponent("sync-state.json")) }
    self.acks = acks
    self.deviceId = deviceId
    self.clock = clock
    events = eventsFile?.read() ?? []
    state = stateFile?.read() ?? SyncState()
  }

  // MARK: - The document

  /// Append closed events (immutable from here); one with a number that is not one, or an id
  /// already waiting, is dropped.
  func append(_ given: [ListeningEvent]) {
    var have = Set(events.map(\.id))
    let add = given.filter { $0.isFinite && have.insert($0.id).inserted }
    guard !add.isEmpty else { return }
    events += add
    saveEvents()
  }

  /// Every event waiting (signing out is blocked while any is, decision 9).
  var unsentCount: Int { events.count }

  /// The couldn't-sync list, entries past 30 days left out.
  func couldNotSync(now: Date? = nil) -> [CouldNotSync] {
    let t = now ?? clock()
    return state.failed.filter { t.timeIntervalSince($0.at) < Self.COULD_NOT_SYNC_KEEP }
  }

  /// Take one event off the couldn't-sync list.
  func discardFailed(_ id: String) {
    state.failed.removeAll { $0.event.id == id }
    saveState()
  }

  /// Drop everything (the listener chose to discard what waits, then signed out).
  func discardAll() {
    events = []
    state = SyncState()
    chunkSize = Self.MAX_CHUNK
    saveEvents()
    saveState()
  }

  private func saveEvents() {
    eventsFile?.write(events)
    onChange?()
  }

  private func saveState() {
    stateFile?.write(state)
    onChange?()
  }

  private func remove(_ ids: Set<String>) {
    guard !ids.isEmpty else { return }
    let before = events.count
    events.removeAll { ids.contains($0.id) }
    if events.count != before { saveEvents() }
  }

  private func moveToFailed(_ items: [(event: ListeningEvent, reason: String)]) {
    guard !items.isEmpty else { return }
    let now = clock()
    let ids = Set(items.map(\.event.id))
    let kept = state.failed.filter { now.timeIntervalSince($0.at) < Self.COULD_NOT_SYNC_KEEP && !ids.contains($0.event.id) }
    state.failed = Array((kept + items.map { CouldNotSync(event: $0.event, reason: $0.reason, at: now) }).suffix(Self.MAX_COULD_NOT_SYNC))
    saveState()
    remove(ids)
  }

  /// Events older than `GIVE_UP_AGE` go to the list unsent (`too_old`): the server refuses one
  /// past 90 days, so it could only wait.
  func giveUpOld() {
    let now = clock()
    let old = events.filter { e in
      guard let t = e.time else { return false }
      return now.timeIntervalSince(t) > Self.GIVE_UP_AGE
    }
    moveToFailed(old.map { ($0, "too_old") })
  }

  // MARK: - Sending

  /// Send what waits. One flush at a time: a call while one runs makes it go round once more.
  func flush(via transport: ListeningSyncTransport) async {
    if let running {
      again = true
      await running.value
      return
    }
    let task = Task { @MainActor in
      repeat {
        again = false
        await flushOnce(transport)
      } while again
    }
    running = task
    await task.value
    running = nil
  }

  private enum Next { case more, stop }

  private func flushOnce(_ transport: ListeningSyncTransport) async {
    giveUpOld()
    lastFlushFailed = false
    for _ in 0..<Self.MAX_ROUNDS {
      if events.isEmpty { return }
      let chunk = Array(events.prefix(chunkSize))
      if await sendChunk(chunk, transport) == .stop { return }
    }
  }

  private func body(_ events: [ListeningEvent]) -> SyncRequest {
    SyncRequest(deviceId: deviceId, sentAt: ISOTime.string(clock()), clockOffset: nil, events: events)
  }

  private func sendChunk(_ chunk: [ListeningEvent], _ transport: ListeningSyncTransport) async -> Next {
    do {
      let sentAt = clock()
      let answer = try await transport.syncListening(body(chunk))
      apply(answer, sent: chunk, sentAt: sentAt, answeredAt: clock())
      return .more
    } catch let e as APIError {
      if e.status == 413 || e.code == "too_many_events" {
        if chunk.count > 1 {
          chunkSize = max(1, chunk.count / 2)
          return .more
        }
        moveToFailed([(chunk[0], "too_large")])
        return .more
      }
      if e.status == 400 { return await sendOneByOne(chunk, transport) }
      // 401, 403, 404/405, 5xx: keep them for a later try.
      lastFlushFailed = true
      return .stop
    } catch {
      lastFlushFailed = true
      return .stop
    }
  }

  private func sendOneByOne(_ chunk: [ListeningEvent], _ transport: ListeningSyncTransport) async -> Next {
    if chunk.count == 1 {
      moveToFailed([(chunk[0], "invalid")])
      return .more
    }
    for event in chunk {
      do {
        let answer = try await transport.syncListening(body([event]))
        apply(answer, sent: [event], sentAt: nil, answeredAt: nil)
      } catch let e as APIError where e.status == 400 {
        moveToFailed([(event, "invalid")])
      } catch {
        lastFlushFailed = true
        return .stop
      }
    }
    return .more
  }

  /// Apply a sync answer for the events `sent`: each answered one leaves (rejected to the
  /// list), the skew is measured when the request's times are known, and a row that kept this
  /// device's event has its version acknowledged.
  func apply(_ answer: SyncResponse, sent: [ListeningEvent], sentAt: Date?, answeredAt: Date?) {
    let results = Dictionary((answer.results ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var done = Set<String>()
    var rejected: [(event: ListeningEvent, reason: String)] = []
    for event in sent {
      guard let r = results[event.id] else { continue }  // no result: try again later
      if r.status == "rejected" { rejected.append((event, r.reason ?? "invalid")) } else { done.insert(event.id) }
    }
    remove(done)
    moveToFailed(rejected)
    if let sentAt, let answeredAt, let skew = ClockSkew.of(serverTime: answer.serverTime, sentAt: sentAt, answeredAt: answeredAt) {
      state.clockSkewMs = skew
    }
    state.lastSyncAt = clock()
    saveState()
    let rows = answer.progress ?? []
    for row in rows where AckRules.keptMine(row, deviceId: deviceId, sent: sent, results: results) {
      acks.ack(row.ref, version: row.version)
    }
    onAnswer?(rows)
  }

  // MARK: - The background upload (decision 10; pass 2's SyncUploader sends it)

  /// The first chunk as a body built now to be sent later: `clock_offset` (the last measured
  /// skew) instead of `sent_at`. Nil with nothing waiting.
  func backgroundBody() -> SyncRequest? {
    giveUpOld()
    guard !events.isEmpty else { return nil }
    return SyncRequest(
      deviceId: deviceId, sentAt: nil, clockOffset: ClockSkew.clockOffset(skewMs: state.clockSkewMs),
      events: Array(events.prefix(chunkSize)))
  }

  /// Apply the answer to a background upload of these event ids (those still waiting; one a
  /// foreground send answered meanwhile has gone). No skew: the request's times are unknown.
  func applyBackground(_ answer: SyncResponse, sentIds: [String]) {
    let byId = Dictionary(events.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    apply(answer, sent: sentIds.compactMap { byId[$0] }, sentAt: nil, answeredAt: nil)
  }
}
