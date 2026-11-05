// The phone-watch message contract (W3 plan, "The phone-watch message contract"): the watch
// receives `pair`, `book` and `remove` from the phone and sends `watch-state`. Every
// message carries `v: 1`; an unknown type or a newer version is ignored. WatchConnectivity hands
// over property-list dictionaries, so decoding works on `[String: Any]`.
import Foundation

/// `<server_id>.<user_id>`: the account a message names and the watch is signed in to (the
/// phone's connection id, `connectionIdOf` in src/lib/connection-id.ts). The one spelling, so
/// the ids compared and the background upload's tag always agree.
func accountIdOf(serverId: String, userId: Int) -> String { "\(serverId).\(userId)" }

/// `pair`: sign the watch in (the phone minted the pairing token with `POST /auth/pair
/// {"ttl_seconds":600}`).
struct PairMessage: Equatable, Sendable {
  var serverId: String
  var serverName: String
  var userId: Int
  var userName: String
  /// Where to exchange first (the pairing payload's `base_url`).
  var baseURL: String
  /// The phone connection's paired URL.
  var serverURL: String
  var addresses: ServerAddresses
  var pairingToken: String
  var expiresAt: Date
  var phoneName: String

  /// The account this message signs in.
  var accountId: String { accountIdOf(serverId: serverId, userId: userId) }

  func expired(now: Date) -> Bool { now >= expiresAt }
}

/// `book`: queue a book for download, like the watch's own Download button. Codable only for
/// `HeldBooks`'s file; the wire form is the dictionary below.
struct BookMessage: Codable, Equatable, Sendable {
  var serverId: String
  var userId: Int
  var ref: BookRef
  var title: String
  var author: String?

  var accountId: String { accountIdOf(serverId: serverId, userId: userId) }
}

/// `remove`: take a book off the watch, as removing it by hand does. Only for the account the
/// watch is signed in to (`HeldBooks.finishRemove`).
struct RemoveMessage: Equatable, Sendable {
  var serverId: String
  var userId: Int
  var ref: BookRef

  var accountId: String { accountIdOf(serverId: serverId, userId: userId) }
}

enum PhoneMessage: Equatable, Sendable {
  case pair(PairMessage)
  case book(BookMessage)
  case remove(RemoveMessage)
}

/// One book on the watch, as `watch-state` reports it.
struct WatchStateBook: Equatable, Sendable {
  enum State: String, Codable, Sendable {
    case queued, preparing, downloading, ready, failed

    /// Still on its way to the watch: what Home lists above Continue listening.
    var onTheWay: Bool { self == .queued || self == .preparing || self == .downloading }
  }
  var ref: BookRef
  var title: String
  var state: State
  var bytes: Int64?
}

/// `watch-state`: the latest only (`updateApplicationContext`).
struct WatchState: Equatable, Sendable {
  var signedIn: Bool
  var serverId: String?
  var userId: Int?
  var appVersion: String
  var books: [WatchStateBook]
  var unsentEvents: Int
  var couldntSync: Int
  var lastSyncAt: Date?
}

enum PhoneMessages {
  static let VERSION = 1

  /// Decode a received message; nil for an unknown type, a newer version or a malformed one.
  static func decode(_ m: [String: Any]) -> PhoneMessage? {
    guard let v = int(m["v"]), v == VERSION, let type = m["type"] as? String else { return nil }
    switch type {
    case "pair": return decodePair(m).map(PhoneMessage.pair)
    case "book": return decodeBook(m).map(PhoneMessage.book)
    case "remove": return decodeRemove(m).map(PhoneMessage.remove)
    default: return nil
    }
  }

  /// A message given as JSON text (the DEBUG simulator sign-in's `AUDIOSILO_DEBUG_PAIR`).
  static func decodeJSON(_ text: String) -> PhoneMessage? {
    guard let data = text.data(using: .utf8),
      let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return nil }
    return decode(m)
  }

  private static func decodePair(_ m: [String: Any]) -> PairMessage? {
    guard let serverId = nonEmpty(m["server_id"]), let userId = int(m["user_id"]),
          let base = httpURL(m["base_url"]), let token = nonEmpty(m["pairing_token"]),
          let expires = date(m["expires_at"])
    else { return nil }
    let addrs = m["addresses"] as? [String: Any] ?? [:]
    return PairMessage(
      serverId: serverId, serverName: m["server_name"] as? String ?? "", userId: userId,
      userName: m["user_name"] as? String ?? "", baseURL: base,
      serverURL: httpURL(m["server_url"]) ?? base,
      addresses: ServerAddresses(home: httpURL(addrs["home"]), away: httpURL(addrs["away"])),
      pairingToken: token, expiresAt: expires, phoneName: m["phone_name"] as? String ?? "")
  }

  private static func decodeBook(_ m: [String: Any]) -> BookMessage? {
    guard let serverId = nonEmpty(m["server_id"]), let userId = int(m["user_id"]),
          let lib = int(m["library_id"]), let path = nonEmpty(m["path"])
    else { return nil }
    return BookMessage(
      serverId: serverId, userId: userId, ref: BookRef(libraryId: lib, path: path),
      title: m["title"] as? String ?? path, author: nonEmpty(m["author"]))
  }

  private static func decodeRemove(_ m: [String: Any]) -> RemoveMessage? {
    decodeBook(m).map { RemoveMessage(serverId: $0.serverId, userId: $0.userId, ref: $0.ref) }
  }

  /// `watch-state` as a property list (no nils: WatchConnectivity takes plist types only).
  static func encode(_ s: WatchState) -> [String: Any] {
    var out: [String: Any] = [
      "v": VERSION, "type": "watch-state", "signed_in": s.signedIn, "app_version": s.appVersion,
      "unsent_events": s.unsentEvents, "couldnt_sync": s.couldntSync,
      "books": s.books.map { b -> [String: Any] in
        var d: [String: Any] = [
          "library_id": b.ref.libraryId, "path": b.ref.path, "title": b.title, "state": b.state.rawValue,
        ]
        if let bytes = b.bytes { d["bytes"] = bytes }
        return d
      },
    ]
    if let id = s.serverId { out["server_id"] = id }
    if let id = s.userId { out["user_id"] = id }
    if let t = s.lastSyncAt { out["last_sync_at"] = ISOTime.string(t) }
    return out
  }

  // MARK: - Reading plist values

  static func int(_ v: Any?) -> Int? {
    if let n = v as? Int { return n }
    if let n = v as? NSNumber, n.doubleValue == n.doubleValue.rounded() { return n.intValue }
    if let s = v as? String { return Int(s) }
    return nil
  }

  private static func nonEmpty(_ v: Any?) -> String? {
    guard let s = v as? String, !s.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    return s
  }

  private static func httpURL(_ v: Any?) -> String? {
    guard let s = nonEmpty(v), let e = URLEndpoint(s), e.scheme == "http" || e.scheme == "https" else { return nil }
    return s
  }

  /// An RFC 3339 string, or seconds since 1970.
  private static func date(_ v: Any?) -> Date? {
    if let s = v as? String { return ISOTime.parse(s) }
    if let n = v as? NSNumber { return Date(timeIntervalSince1970: n.doubleValue) }
    return nil
  }
}
