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
