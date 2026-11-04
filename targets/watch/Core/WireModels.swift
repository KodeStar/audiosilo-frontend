// The server's JSON as the watch reads and sends it, mirrored by hand from the phone's
// `src/api/types.ts` (there is no codegen: a wire change touches both). Foundation only:
// `watch-core/` compiles this folder on the host for its tests.
//
// Keys are snake_case on the wire and camelCase here (`Wire.decoder` / `Wire.encoder`).
// An optional is left out of an encoded body when nil (Codable's `encodeIfPresent`).
import Foundation

/// The coders every wire read and write goes through.
enum Wire {
  static var decoder: JSONDecoder {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
  }

  static var encoder: JSONEncoder {
    let e = JSONEncoder()
    e.keyEncodingStrategy = .convertToSnakeCase
    e.outputFormatting = [.sortedKeys]
    return e
  }
}

// MARK: - Server

struct ServerAddresses: Codable, Equatable, Sendable {
  var home: String?
  var away: String?
}

/// The capability flags the watch reads (`GET /api/v1/server`). Absent means an older server.
struct ServerCapabilities: Codable, Equatable, Sendable {
  var listeningSync: Bool?
  var renditions: Bool?
  var coverSizes: Bool?
  var addresses: Bool?
}

struct ServerInfo: Codable, Equatable, Sendable {
  var name: String?
  var serverId: String?
  var version: String?
  var capabilities: ServerCapabilities?
  /// The rendition kinds the server makes (`["watch"]`). Absent on servers before 2.6.
  var renditions: [String]?

  /// Decision 5: the watch app needs Sync v2 (`listening_sync`) and the watch rendition. No
  /// `PUT .../progress` fallback on the watch: an older server gets the "too old" screen.
  var supportsWatch: Bool {
    capabilities?.listeningSync == true && (renditions ?? []).contains("watch")
  }
}

struct WireUser: Codable, Equatable, Sendable {
  var id: Int
  var username: String
  var displayName: String?
}

/// `POST /auth/exchange` answer.
struct AuthSession: Codable, Equatable, Sendable {
  var token: String
  var serverId: String
  var user: WireUser
  var addresses: ServerAddresses?
}

/// A server error body: `{"error": msg, "code": code}`.
struct APIErrorBody: Codable, Sendable {
  var error: String?
  var code: String?
}

/// A server's own answer that was not a success (any status outside 2xx). Anything else a
/// request throws (a `URLError`) means no server answered: offline, for the outbox's rules.
struct APIError: Error, Equatable, Sendable {
  var status: Int
  var code: String?
  var message: String?
  /// `Retry-After` in seconds, when the answer carried one.
  var retryAfter: Double?
}

extension APIError {
  /// The longest wait a `Retry-After` is taken for: any longer is this long (a wait the watch
  /// sleeps for in nanoseconds must fit a UInt64; the phone takes any).
  static let MAX_RETRY_AFTER: Double = 3600

  /// A refused answer: its status, its JSON error body (when it parses) and its `Retry-After`.
  init(status: Int, body: Data?, retryAfterHeader: String?) {
    let parsed = body.flatMap { try? Wire.decoder.decode(APIErrorBody.self, from: $0) }
    self.init(status: status, code: parsed?.code, message: parsed?.error,
              retryAfter: retryAfterHeader.flatMap(Self.retryAfterSeconds))
  }

  /// A `Retry-After` header in seconds when it reads as a finite, non-negative number (the
  /// phone's rule: a date or anything else reads as none), at most `MAX_RETRY_AFTER`.
  static func retryAfterSeconds(_ header: String) -> Double? {
    guard let n = Double(header.trimmingCharacters(in: .whitespaces)), n.isFinite, n >= 0 else { return nil }
    return min(n, MAX_RETRY_AFTER)
  }
}

// MARK: - Books

struct BookFile: Codable, Equatable, Sendable {
  var relPath: String
  var seq: Int
  var duration: Double
  var format: String?
  var size: Int64
}

struct Chapter: Codable, Equatable, Sendable {
  var index: Int
  var title: String
  var fileIndex: Int
  var filePath: String
  var start: Double
  var end: Double
  var bookOffset: Double
}

/// `GET /libraries/{id}/item` (the fields the watch uses).
struct Book: Codable, Equatable, Sendable {
  var libraryId: Int?
  var relPath: String
  var title: String
  var author: String?
  var narrator: String?
  var duration: Double
  var size: Int64?
  var files: [BookFile]?
  var chapters: [Chapter]?
}

/// `GET /libraries/{id}/chapters`.
struct ChaptersResponse: Codable, Equatable, Sendable {
  var duration: Double?
  var files: [BookFile]?
  var chapters: [Chapter]?
}

// MARK: - Progress (Sync v2)

/// A place the server did not keep (the losing side of a diverged event).
struct OtherPlace: Codable, Equatable, Sendable {
  var position: Double
  var deviceId: String
  var deviceName: String?
  var updatedAt: String
}

/// A book's progress row (`Progress` in types.ts; renamed here, Foundation has a `Progress`).
struct ProgressRow: Codable, Equatable, Sendable {
  var libraryId: Int
  var path: String
  var position: Double
  var duration: Double
  var finished: Bool
  var playbackSpeed: Double?
  var version: Int
  var deviceId: String?
  var updatedAt: String
  var startedAt: String?
  var finishedAt: String?
  var deviceName: String?
  var otherPlace: OtherPlace?

  var ref: BookRef { BookRef(libraryId: libraryId, path: path) }
}

/// `GET /me/progress`.
struct ProgressList: Codable, Sendable {
  var progress: [ProgressRow]?
}

/// A book by its identity (CROSS-REPO section 1: path is the identity, never a DB id).
struct BookRef: Codable, Hashable, Sendable {
  var libraryId: Int
  var path: String

  /// One string per book, for file names and dictionary keys.
  var key: String { "\(libraryId)\u{0}\(path)" }
}

// MARK: - Listening events (Sync v2, `POST /me/listening/sync`)

/// Why a span began.
enum ListeningStart: String, Codable, Sendable {
  case resume
  case `continue`
  case movedBack = "moved_back"
  case jump
  case restart
}

/// A span of listening: whole-book seconds on this device's timeline, each end's audio file
/// (rel path) and seconds in it (both of a pair or neither), the device's length of the book,
/// the speed (absent = 1), the wall times (RFC 3339, device clock), why it began, and the
/// version this device had acknowledged (`base_version`).
struct SpanEvent: Codable, Equatable, Sendable {
  var id: String
  var kind: String = "listen"
  var libraryId: Int
  var path: String
  var fromPos: Double
  var toPos: Double
  var fromFile: String?
  var fromFilePos: Double?
  var toFile: String?
  var toFilePos: Double?
  var duration: Double?
  var playbackSpeed: Double?
  var startedAt: String
  var endedAt: String
  var start: ListeningStart
  var baseVersion: Int?
}

/// Marking a book finished (`finish`) or not (`unfinish`) at `at`.
struct FinishEvent: Codable, Equatable, Sendable {
  var id: String
  var kind: String
  var libraryId: Int
  var path: String
  var at: String
  var baseVersion: Int?
}

enum ListeningEvent: Codable, Equatable, Sendable {
  case listen(SpanEvent)
  case finish(FinishEvent)

  var id: String {
    switch self {
    case .listen(let e): return e.id
    case .finish(let e): return e.id
    }
  }

  var ref: BookRef {
    switch self {
    case .listen(let e): return BookRef(libraryId: e.libraryId, path: e.path)
    case .finish(let e): return BookRef(libraryId: e.libraryId, path: e.path)
    }
  }

  /// When it happened: a span's end, a finish's `at`.
  var time: Date? {
    switch self {
    case .listen(let e): return ISOTime.parse(e.endedAt)
    case .finish(let e): return ISOTime.parse(e.at)
    }
  }

  /// Whether every number it carries is finite: one that is not is never enqueued (JSON has
  /// no NaN). `eventIsFinite` in listening-outbox.ts.
  var isFinite: Bool {
    switch self {
    case .finish: return true
    case .listen(let e):
      let numbers = [e.fromPos, e.toPos, e.fromFilePos, e.toFilePos, e.duration, e.playbackSpeed]
      return numbers.allSatisfy { $0?.isFinite ?? true }
    }
  }

  private enum KindKey: String, CodingKey { case kind }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: KindKey.self)
    let kind = try c.decode(String.self, forKey: .kind)
    if kind == "listen" {
      self = .listen(try SpanEvent(from: decoder))
    } else {
      self = .finish(try FinishEvent(from: decoder))
    }
  }

  func encode(to encoder: Encoder) throws {
    switch self {
    case .listen(let e): try e.encode(to: encoder)
    case .finish(let e): try e.encode(to: encoder)
    }
  }
}

/// The batch envelope: exactly one of `sent_at` (this attempt's device clock: a foreground
/// send) and `clock_offset` (seconds, server minus device: a body built earlier, the
/// background upload).
struct SyncRequest: Codable, Equatable, Sendable {
  var deviceId: String
  var sentAt: String?
  var clockOffset: Double?
  var events: [ListeningEvent]
}

struct SyncResult: Codable, Equatable, Sendable {
  var id: String
  /// applied | duplicate | diverged | not_applied | rejected
  var status: String
  var reason: String?
  /// diverged: event | stored
  var kept: String?
  var otherPlace: OtherPlace?
}

struct SyncResponse: Codable, Equatable, Sendable {
  var serverTime: String?
  var results: [SyncResult]?
  var progress: [ProgressRow]?
}

// MARK: - Renditions (Track W2)

/// One audio file's watch rendition: `path` is the original file (as `/stream` takes it).
struct RenditionFile: Codable, Equatable, Sendable {
  var path: String
  /// ready | pending | failed | missing
  var state: String
  var bytes: Int64?
  var retryAfterSeconds: Double?
}

/// `POST`/`GET /libraries/{id}/renditions`.
struct RenditionsAnswer: Codable, Equatable, Sendable {
  var kind: String?
  var files: [RenditionFile]
}

// MARK: - Time

/// RFC 3339 times as the phone writes them (`Date.toISOString()`: UTC, milliseconds), and a
/// lenient read of the server's (Go's RFC3339Nano: any number of fraction digits, or none).
enum ISOTime {
  private static let writer: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    f.timeZone = TimeZone(identifier: "UTC")
    return f
  }()

  private static let plain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()

  static func string(_ date: Date) -> String { writer.string(from: date) }

  static func parse(_ s: String) -> Date? {
    // Split off the fraction (any length), read the rest, add the fraction back.
    guard let t = s.firstIndex(of: "T") else { return nil }
    var whole = s
    var fraction = 0.0
    if let dot = s[t...].firstIndex(of: ".") {
      var end = s.index(after: dot)
      while end < s.endIndex, s[end].isNumber { end = s.index(after: end) }
      fraction = Double("0" + s[dot..<end]) ?? 0
      whole = String(s[..<dot]) + String(s[end...])
    }
    guard let base = plain.date(from: whole) else { return nil }
    return base.addingTimeInterval(fraction)
  }
}
