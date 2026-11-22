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
//
// `lastFlushFailed` says the last ANSWER: true from a failed attempt until the server next answers,
// also while a retry is in flight (it is what the 15 s cut reads, so offline the span stays open).
// A file that exists but can't be read is moved aside, never overwritten (`restoredEvents`); one
// that can't be moved either stays in the way, unwritten, until a later save can (`stuck`).
import Foundation

/// An event the server would not take, kept to show (the couldn't-sync list).
struct CouldNotSync: Codable, Equatable, Sendable {
  var event: ListeningEvent
  var reason: String
  var at: Date
}

/// A finish or download removal suppresses older queued listening until it leaves the outbox.
private enum SentPlace: Codable, Equatable {
  case heard(place: LocalPlace)
  case finished(through: Date)
  case removed

  var place: LocalPlace? {
    if case .heard(let place) = self { return place }
    return nil
  }

  /// Merge independent copies on the watch's clock. A removed download stays removed until a fresh cut.
  static func newer(_ kept: Self, _ cut: Self) -> Self {
    switch (kept, cut) {
    case (.removed, _), (_, .removed): return .removed
    case (.heard(let a), .heard(let b)): return .heard(place: LocalPlace.newer(a, b))
    case (.finished(let a), .finished(let b)): return .finished(through: max(a, b))
    case (.heard(let place), .finished(let end)), (.finished(let end), .heard(let place)):
      return place.at > end ? .heard(place: place) : .finished(through: end)
    }
  }

  /// Each book's last heard cut or finish in queue order, including a deliberate move while paused.
  static func lastHeard(in events: ArraySlice<ListeningEvent>) -> [String: Self] {
    var places: [String: Self] = [:]
    for event in events {
      switch event {
      case .listen(let cut) where cut.heardPlace:
        guard let at = event.time else { continue }
        places[event.ref.key] = .heard(place: LocalPlace(position: cut.toPos, file: cut.toFile, filePos: cut.toFilePos,
                                                        at: at, speed: cut.playbackSpeed ?? 1))
      case .finish(let end) where end.kind == "finish":
        if let at = event.time { places[event.ref.key] = .finished(through: at) }
      default: continue
      }
    }
    return places
  }
}

private struct SentPlaces: Codable, Equatable {
  var accountId: String
  var books: [String: SentPlace] = [:]
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
  private let sentPlacesFile: JSONFile<SentPlaces>?
  private var sentPlaces: SentPlaces?
  private var sentPlacesWriteFailed = false
  private let acks: AckStore
  /// Asked when first needed, never at launch: before the watch's first unlock the id kept for it
  /// can't be read yet (`Files.deviceId`), and nothing is sent until it can.
  private let deviceIdOf: () -> String
  private var deviceId: String { deviceIdOf() }
  private let clock: () -> Date
  private var placeAccount: String?

  private(set) var events: [ListeningEvent]
  private(set) var state: SyncState
  /// The outbox file is there, but could be neither read nor moved aside: nothing is written over
  /// it, so what waits is in memory alone until a save finds it reads or moves (`saveEvents`).
  private var stuck = false
  private var eventsWriteFailed = false
  /// The server has not answered since a flush failed (offline, or the server failed).
  private(set) var lastFlushFailed = false

  private let directory: URL?
  private var chunkSize = Outbox.MAX_CHUNK
  private var running: Task<Void, Never>?
  private var again = false
  /// The transport the newest `flush` call brought: each chunk goes through it.
  private var transport: ListeningSyncTransport?
  /// Bumped by `discardAll`: an answer or a failure of a request sent before it says nothing
  /// about what waits now, and ends that flush.
  private var discards = 0

  /// Whether the server takes a `stay` span now (`listening_stay`); asked as each body is built.
  var takesStay: () -> Bool = { false }
  /// Told of every answer's progress rows (the offer check), and of the books whose `stay` it
  /// held (`AckRules.staysHeld`).
  var onAnswer: (([ProgressRow], Set<BookRef>) -> Void)?
  /// Told whenever the events or the state change (watch-state, Sync status).
  var onChange: (() -> Void)?

  /// `directory` nil keeps everything in memory (tests).
  init(directory: URL?, acks: AckStore, deviceId: @autoclosure @escaping () -> String,
       clock: @escaping () -> Date = Date.init) {
    self.directory = directory
    eventsFile = directory.map { JSONFile(url: $0.appendingPathComponent("outbox.json")) }
    stateFile = directory.map { JSONFile(url: $0.appendingPathComponent("sync-state.json")) }
    sentPlacesFile = directory.map { JSONFile(url: $0.appendingPathComponent("sent-places.json")) }
    self.acks = acks
    deviceIdOf = deviceId
    self.clock = clock
    let restored = directory.map(Self.restoredEvents)
    events = restored?.events ?? []
    stuck = restored?.stuck ?? false
    state = stateFile?.read() ?? SyncState()
    sentPlaces = sentPlacesFile?.read()
  }

  // MARK: - The document

  private static let ASIDE_PREFIX = "outbox-unread-"

  private static func asideFiles(in directory: URL) -> [URL] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    return names.filter { $0.hasPrefix(ASIDE_PREFIX) }.map(directory.appendingPathComponent)
  }

  /// The outbox file's events, nil with none that reads. One there that can't be read (damaged, or
  /// locked until the watch's first unlock) is moved aside; `stuck` when that failed too, so it
  /// is still in the way and must not be written over.
  private static func kept(in main: JSONFile<[ListeningEvent]>) -> (events: [ListeningEvent]?, stuck: Bool) {
    switch main.load() {
    case .value(let v): return (v, false)
    case .missing: return (nil, false)
    case .unreadable, .corrupt: return (nil, !main.moveAside(prefix: ASIDE_PREFIX))
    }
  }

  /// What waited at the last launch. A file that exists but can't be read is moved aside (`kept`),
  /// so the next save never writes over that listening, and joins what waits at a later launch if
  /// it reads by then. `stuck`: it could not be moved, so nothing was written (what was set aside
  /// earlier stays there, joined in memory alone).
  private static func restoredEvents(in directory: URL) -> (events: [ListeningEvent], stuck: Bool) {
    let fm = FileManager.default
    let main = JSONFile<[ListeningEvent]>(url: directory.appendingPathComponent("outbox.json"))
    let (current, stuck) = kept(in: main)
    var have = Set((current ?? []).map(\.id))
    var older: [ListeningEvent] = []
    var joined: [URL] = []
    for url in asideFiles(in: directory) {
      guard let more = JSONFile<[ListeningEvent]>(url: url).read() else { continue }
      older += more.filter { have.insert($0.id).inserted }
      joined.append(url)
    }
    let events = older + (current ?? [])
    guard !joined.isEmpty, !stuck else { return (events, stuck) }
    main.write(events)
    // Gone only once they are safely in the outbox (a full disk: tried again next launch).
    if main.read()?.count == events.count { joined.forEach { try? fm.removeItem(at: $0) } }
    return (events, false)
  }

  /// `kept` joins what waits here, first and once each by id. True when anything here was not in it.
  private func join(_ kept: [ListeningEvent]) -> Bool {
    var have = Set(kept.map(\.id))
    let since = events.filter { have.insert($0.id).inserted }
    events = kept + since
    return !since.isEmpty
  }

  /// Read the files again: a launch before the watch's first unlock read nothing and set the
  /// outbox aside, so it joins what waits now (once each, by id), as at a launch, and the state
  /// kept is taken. Until then it counted as empty, so this comes before any sign-in or sign-out
  /// asks how much waits (`AppModel.catchUp`).
  func reload() {
    guard let directory else { return }
    let restored = Self.restoredEvents(in: directory)
    stuck = restored.stuck
    let more = join(restored.events)
    if let kept = stateFile?.read() { state = kept }
    if let kept = sentPlacesFile?.read() { sentPlaces = kept }
    if more { saveEvents() } else { onChange?() }
  }

  /// Restore each book's place from the account's kept cuts and the last heard cut per book in
  /// queue order. The one open span recovered at launch can be an older span whose removal
  /// failed, so compare its end with the cut already in the queue.
  func restorePlaces(for accountId: String?, into places: PlaceStore, recoverSpan: () -> Void = {}) {
    guard let accountId, placeAccount != accountId else {
      recoverSpan()
      return
    }
    let queued = events.count
    recoverSpan()
    var cuts = SentPlace.lastHeard(in: events.prefix(queued))
    cuts.merge(SentPlace.lastHeard(in: events.dropFirst(queued)), uniquingKeysWith: SentPlace.newer)
    placeAccount = accountId
    var kept = sentPlaces ?? SentPlaces(accountId: accountId)
    guard kept.accountId == accountId else { return }
    kept.books.merge(cuts, uniquingKeysWith: SentPlace.newer)
    savePlaces(kept)
    places.recover(kept.books.compactMapValues(\.place))
  }

  /// Record fresh cuts as they enter the queue. A retry or a late upload answer cannot reorder them.
  private func recordPlaces(in events: [ListeningEvent]) {
    guard let placeAccount else { return }
    let cuts = SentPlace.lastHeard(in: events[...])
    guard !cuts.isEmpty else { return }
    var kept = sentPlaces ?? SentPlaces(accountId: placeAccount)
    if kept.accountId != placeAccount { kept = SentPlaces(accountId: placeAccount) }
    kept.books.merge(cuts) { _, cut in cut }
    savePlaces(kept)
  }

  func forgetPlace(_ ref: BookRef) {
    guard var kept = sentPlaces, kept.accountId == placeAccount else { return }
    kept.books[ref.key] = .removed
    savePlaces(kept)
  }

  private func savePlaces(_ places: SentPlaces) {
    var kept = places
    // A failed queue write can leave older cuts on disk even after their upload was answered.
    if kept.books.values.contains(where: { $0.place == nil }) {
      var waiting: Set<String> = []
      for event in events {
        guard case .listen(let cut) = event, cut.heardPlace else { continue }
        let key = event.ref.key
        waiting.insert(key)
        // A cut queued before a finish can have a later timestamp if the watch clock moved back.
        // Even if the finish is acknowledged first, that cut must stay forgotten.
        if case .finished(let through) = kept.books[key], let at = event.time, at > through {
          kept.books[key] = .finished(through: at)
        }
      }
      if !stuck, !eventsWriteFailed {
        kept.books = kept.books.filter { $0.value.place != nil || waiting.contains($0.key) }
      }
    }
    guard kept != sentPlaces || sentPlacesWriteFailed else { return }
    sentPlaces = kept
    sentPlacesWriteFailed = sentPlacesFile?.write(kept) == false
  }

  /// Append closed events (immutable from here); one with a number that is not one, or an id
  /// already waiting, is dropped.
  func append(_ given: [ListeningEvent]) {
    var have = Set(events.map(\.id))
    let add = given.filter { $0.isFinite && have.insert($0.id).inserted }
    guard !add.isEmpty else { return }
    events += add
    saveEvents()
    recordPlaces(in: add)
  }

  /// Every event waiting (signing out is blocked while any is, decision 9).
  var unsentCount: Int { events.count }

  /// The couldn't-sync list, entries past 30 days left out.
  func couldNotSync(now: Date? = nil) -> [CouldNotSync] {
    let t = now ?? clock()
    return state.failed.filter { Self.stillKept($0, now: t) }
  }

  /// Whether a couldn't-sync entry is still kept (30 days).
  private static func stillKept(_ f: CouldNotSync, now: Date) -> Bool {
    now.timeIntervalSince(f.at) < COULD_NOT_SYNC_KEEP
  }

  /// Take one event off the couldn't-sync list.
  func discardFailed(_ id: String) {
    state.failed.removeAll { $0.event.id == id }
    saveState()
  }

  /// Drop everything (the listener chose to discard what waits, then signed out).
  func discardAll() {
    discards += 1
    transport = nil
    again = false
    events = []
    state = SyncState()
    sentPlaces = nil
    sentPlacesWriteFailed = false
    placeAccount = nil
    chunkSize = Self.MAX_CHUNK
    // Nothing waits, so nothing failed: the 15 s cut runs again (the cold-start state).
    lastFlushFailed = false
    // Never joined to another account's outbox at a later launch.
    if let directory { Self.asideFiles(in: directory).forEach { try? FileManager.default.removeItem(at: $0) } }
    // A file still in the way goes with them: the listener chose to drop what waits.
    stuck = false
    saveEvents()
    sentPlacesFile?.write(nil)
    saveState()
  }

  private func saveEvents() {
    if stuck, let eventsFile {
      // The file in the way, tried again: it joins if it reads now, else it is moved aside.
      let again = Self.kept(in: eventsFile)
      stuck = again.stuck
      if let kept = again.events { _ = join(kept) }
    }
    // Never over a file that could be neither read nor moved.
    if !stuck { eventsWriteFailed = eventsFile?.write(events) == false }
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
    if events.count != before {
      saveEvents()
      if let kept = sentPlaces, kept.accountId == placeAccount { savePlaces(kept) }
    }
  }

  private func moveToFailed(_ items: [(event: ListeningEvent, reason: String)]) {
    guard !items.isEmpty else { return }
    let now = clock()
    let ids = Set(items.map(\.event.id))
    let kept = state.failed.filter { Self.stillKept($0, now: now) && !ids.contains($0.event.id) }
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

  /// Send what waits. One flush at a time: a call while one runs makes it go round once more,
  /// through the transport that call brought (the address or the token may have changed).
  func flush(via transport: ListeningSyncTransport) async {
    self.transport = transport
    if let running {
      again = true
      await running.value
      return
    }
    let task = Task { @MainActor in
      repeat {
        again = false
        await flushOnce()
      } while again
      // In the same step that last read `again`: a call can't slip in between and be lost.
      running = nil
      self.transport = nil
    }
    running = task
    await task.value
  }

  private enum Next { case more, stop }

  private func flushOnce() async {
    giveUpOld()
    for _ in 0..<Self.MAX_ROUNDS {
      if events.isEmpty {
        // Nothing waits, so nothing failed.
        lastFlushFailed = false
        return
      }
      guard let transport else { return }
      let chunk = Array(events.prefix(chunkSize))
      if await sendChunk(chunk, transport) == .stop { return }
    }
  }

  private func body(_ events: [ListeningEvent]) -> SyncRequest {
    SyncRequest(
      deviceId: deviceId, sentAt: ISOTime.string(clock()), clockOffset: nil,
      events: Self.asServerTakes(events, stay: takesStay()))
  }

  /// The events as the server takes them now: a `stay` queued while it had `listening_stay` goes
  /// as a `jump` once the flag is gone (an older server's decoder refuses the start). The stored
  /// event is unchanged and keeps its id, so the answer still matches it.
  static func asServerTakes(_ events: [ListeningEvent], stay: Bool) -> [ListeningEvent] {
    guard !stay else { return events }
    return events.map { e in
      guard case .listen(var s) = e, s.start == .stay else { return e }
      s.start = .jump
      return .listen(s)
    }
  }

  private func sendChunk(_ chunk: [ListeningEvent], _ transport: ListeningSyncTransport) async -> Next {
    let sentBefore = discards
    do {
      let sentAt = clock()
      let answer = try await transport.syncListening(body(chunk))
      guard sentBefore == discards else { return .stop }
      apply(answer, sent: chunk, sentAt: sentAt, answeredAt: clock())
      return .more
    } catch let e as APIError {
      guard sentBefore == discards else { return .stop }
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
      guard sentBefore == discards else { return .stop }
      lastFlushFailed = true
      return .stop
    }
  }

  private func sendOneByOne(_ chunk: [ListeningEvent], _ transport: ListeningSyncTransport) async -> Next {
    if chunk.count == 1 {
      moveToFailed([(chunk[0], "invalid")])
      return .more
    }
    let sentBefore = discards
    for event in chunk {
      do {
        let answer = try await transport.syncListening(body([event]))
        guard sentBefore == discards else { return .stop }
        apply(answer, sent: [event], sentAt: nil, answeredAt: nil)
      } catch let e as APIError where e.status == 400 {
        guard sentBefore == discards else { return .stop }
        moveToFailed([(event, "invalid")])
      } catch {
        guard sentBefore == discards else { return .stop }
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
    // The server answered: reachable, so the 15 s cuts run again.
    lastFlushFailed = false
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
    // As sent: a `stay` that went as a `jump` (the flag gone) was held by the usual rule.
    onAnswer?(rows, AckRules.staysHeld(sent: Self.asServerTakes(sent, stay: takesStay()), results: results))
  }

  // MARK: - The background upload (decision 10; SyncUploader sends it)

  /// The first chunk as a body built now to be sent later: `clock_offset` (the last measured
  /// skew) instead of `sent_at`. Nil with nothing waiting.
  func backgroundBody() -> SyncRequest? {
    giveUpOld()
    guard !events.isEmpty else { return nil }
    return SyncRequest(
      deviceId: deviceId, sentAt: nil, clockOffset: ClockSkew.clockOffset(skewMs: state.clockSkewMs),
      events: Self.asServerTakes(Array(events.prefix(chunkSize)), stay: takesStay()))
  }

  /// Apply the answer to a background upload of these event ids (those still waiting; one a
  /// foreground send answered meanwhile has gone). No skew: the request's times are unknown.
  func applyBackground(_ answer: SyncResponse, sentIds: [String]) {
    let byId = Dictionary(events.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    apply(answer, sent: sentIds.compactMap { byId[$0] }, sentAt: nil, answeredAt: nil)
  }
}
