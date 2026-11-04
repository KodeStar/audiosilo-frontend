// The background upload of the outbox (decision 10): when the app goes to the background (or a
// span closes there) with events unsent, a snapshot body carrying `clock_offset` is handed to a
// background URLSession, which sends it when a network appears, without the app open. Its
// answer arrives on a later wake and is applied like a foreground one (`Outbox.applyBackground`);
// replays are safe, the event ids are the idempotency keys.
import Foundation

/// What an upload task carries in its `taskDescription`: whose events and which.
struct SyncUploadTag: Codable, Equatable, Sendable {
  /// `server_id.user_id`: an answer for an account since replaced is not applied.
  var accountId: String
  var ids: [String]
}

enum BackgroundSync {
  enum Outcome: Equatable {
    /// The server answered for the batch: apply it.
    case answered(SyncResponse)
    /// No usable answer (offline, a refusal, a body that does not parse): the events wait for
    /// the foreground flush, which handles 413/400 by its own rules.
    case keep
  }

  /// What a finished upload means: `status` nil when no answer came.
  static func outcome(status: Int?, body: Data?) -> Outcome {
    guard let status, (200..<300).contains(status), let body,
      let answer = try? Wire.decoder.decode(SyncResponse.self, from: body)
    else { return .keep }
    return .answered(answer)
  }

  /// A task's tag as its `taskDescription` (JSON), and back (the upload's and the downloads').
  static func describe<T: Encodable>(_ tag: T) -> String? {
    (try? JSONEncoder().encode(tag)).flatMap { String(data: $0, encoding: .utf8) }
  }

  static func tag<T: Decodable>(_ description: String?, as: T.Type = T.self) -> T? {
    guard let d = description?.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(T.self, from: d)
  }

  /// Whether an upload's answer belongs to the account signed in now.
  static func applies(_ tag: SyncUploadTag, accountId: String?) -> Bool {
    tag.accountId == accountId && !tag.ids.isEmpty
  }
}

/// One background session's wake (`backgroundTask(.urlSession)`): `wait` resolves at
/// `urlSessionDidFinishEvents`, also when those events came just before the wait began (a cold
/// launch delivers them before the task's closure runs), and at the latest after its timeout, so
/// a wake whose events never come does not hold the task until the system expires it.
final class BackgroundWake: @unchecked Sendable {
  static let TIMEOUT: TimeInterval = 20
  /// Events this recent count for a wait that begins now; older ones were an earlier wake's.
  static let EARLY_WINDOW: TimeInterval = 30

  private let lock = NSLock()
  private let clock: () -> Date
  /// The wakes waiting (the system can hand over a second before the first's events are in;
  /// each one's background task completes only when its wait returns).
  private var waiting: [UUID: CheckedContinuation<Void, Never>] = [:]
  /// When the events were delivered with nobody waiting.
  private var finishedEarlyAt: Date?

  init(clock: @escaping () -> Date = Date.init) {
    self.clock = clock
  }

  func wait(timeout: TimeInterval = BackgroundWake.TIMEOUT) async {
    let id = UUID()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      lock.lock()
      let early = finishedEarlyAt.map { clock().timeIntervalSince($0) < Self.EARLY_WINDOW } ?? false
      finishedEarlyAt = nil
      if early {
        lock.unlock()
        c.resume()
        return
      }
      waiting[id] = c
      lock.unlock()
      DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { self.giveUp(id) }
    }
  }

  private func giveUp(_ id: UUID) {
    lock.lock()
    let c = waiting.removeValue(forKey: id)
    lock.unlock()
    c?.resume()
  }

  /// `urlSessionDidFinishEvents`: resolve every wait on the main queue, after what the
  /// delegate already handed it.
  func finished() {
    lock.lock()
    let done = Array(waiting.values)
    waiting = [:]
    if done.isEmpty { finishedEarlyAt = clock() }
    lock.unlock()
    DispatchQueue.main.async { done.forEach { $0.resume() } }
  }
}
