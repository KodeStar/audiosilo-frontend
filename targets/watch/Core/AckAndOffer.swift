// The acknowledged version per book (`base_version`) and the offer of another device's place,
// ports of `progress-sync.ts` (`ackVersion`, `answerOffer`), `listening-outbox.ts`
// (`keptMine`) and `place-reconcile.ts` (`offerOf`, `OFFER_REPEAT_MS`). CROSS-REPO section 25:
// every span carries `base_version`, the version this device acknowledged when it closed (0 on
// a cold start), so an old offline span never moves a further place back.
import Foundation

/// What the watch keeps per book: the acknowledged version and the offers answered.
struct BookAck: Codable, Equatable, Sendable {
  var ackVersion: Int?
  /// `device_id|updated_at` keys of the offers answered (the newest `MAX_ANSWERED`).
  var answered: [String] = []
}

/// The acknowledged versions, kept in a file (`acks.json`).
@MainActor
final class AckStore {
  static let MAX_ANSWERED = 20

  private let file: JSONFile<[String: BookAck]>?
  private var books: [String: BookAck]

  /// `url` nil keeps it in memory only (tests).
  init(url: URL?) {
    file = url.map { JSONFile(url: $0) }
    books = file?.read() ?? [:]
  }

  func ackVersion(_ ref: BookRef) -> Int? { books[ref.key]?.ackVersion }
  func answered(_ ref: BookRef) -> [String] { books[ref.key]?.answered ?? [] }

  /// Acknowledge `version` of a book's row; never lowers a known acknowledgement.
  func ack(_ ref: BookRef, version: Int) {
    var b = books[ref.key] ?? BookAck()
    if let known = b.ackVersion, known >= version { return }
    b.ackVersion = version
    books[ref.key] = b
    file?.write(books)
  }

  /// An offer answered (Jump or Stay): the row's version acknowledged (never lowered) and the
  /// offer's key noted, the newest `MAX_ANSWERED` kept.
  func answerOffer(_ ref: BookRef, row: ProgressRow, key: String) {
    var b = books[ref.key] ?? BookAck()
    b.ackVersion = max(b.ackVersion ?? row.version, row.version)
    b.answered = Array((b.answered.filter { $0 != key } + [key]).suffix(Self.MAX_ANSWERED))
    books[ref.key] = b
    file?.write(books)
  }

  /// An offer closed with neither Jump nor Stay: its key is noted so it is not offered again,
  /// and nothing is acknowledged, so this watch's next spans still never move the other
  /// device's place back (the phone's `ignoreOffer`, fe#208).
  func ignoreOffer(_ ref: BookRef, key: String) {
    var b = books[ref.key] ?? BookAck()
    guard !b.answered.contains(key) else { return }
    b.answered = Array((b.answered + [key]).suffix(Self.MAX_ANSWERED))
    books[ref.key] = b
    file?.write(books)
  }

  /// Resuming from a server row (pull before play): a version above 0 is acknowledged, so the
  /// first span goes on what this device saw. Auto-moving to another device's place is the same.
  func ackResume(_ row: ProgressRow) {
    if row.version > 0 { ack(row.ref, version: row.version) }
  }

  /// Forget every book (signing out).
  func clear() {
    books = [:]
    file?.write(nil)
  }
}

enum AckRules {
  /// Whether the server kept this device's event for the row's book in this answer (applied,
  /// or diverged with the event kept): the rule for acknowledging the row's version.
  static func keptMine(_ row: ProgressRow, deviceId: String, sent: [ListeningEvent], results: [String: SyncResult]) -> Bool {
    guard row.deviceId == deviceId else { return false }
    return sent.contains { e in
      guard e.ref == row.ref, let r = results[e.id] else { return false }
      return r.status == "applied" || (r.status == "diverged" && r.kept == "event")
    }
  }
}

/// Another device's place to offer (never to move to by itself).
struct PlaceOffer: Equatable, Sendable {
  var position: Double
  /// "" when the server doesn't know the device's name.
  var deviceName: String
  /// `device_id|updated_at` of the offered place.
  var key: String
}

enum Offers {
  /// A smaller difference is not worth offering.
  static let MOVE_THRESHOLD: Double = 30
  /// A device's places are offered at most once in this long per book.
  static let OFFER_REPEAT: TimeInterval = 10 * 60

  /// The offer for a row, or nil: (a) the kept row when another device wrote it above this
  /// device's ack version; else (b) the row's `other_place` when another device's; either only
  /// when more than 30 s from here and not answered yet.
  static func offerOf(_ row: ProgressRow?, deviceId: String, ackVersion: Int?, enginePosition: Double,
                      answered: [String] = []) -> PlaceOffer?
  {
    guard let row else { return nil }
    func candidate(position: Double, device: String?, name: String?, updatedAt: String) -> PlaceOffer? {
      guard let device, !device.isEmpty, device != deviceId else { return nil }
      if abs(position - enginePosition) <= MOVE_THRESHOLD { return nil }
      let key = "\(device)|\(updatedAt)"
      return answered.contains(key) ? nil : PlaceOffer(position: position, deviceName: name ?? "", key: key)
    }
    let kept =
      !row.finished && row.version > (ackVersion ?? 0)
      ? candidate(position: row.position, device: row.deviceId, name: row.deviceName, updatedAt: row.updatedAt)
      : nil
    if let kept { return kept }
    guard let other = row.otherPlace else { return nil }
    return candidate(position: other.position, device: other.deviceId, name: other.deviceName, updatedAt: other.updatedAt)
  }
}

/// Each offer once per launch, each device at most once per book in `OFFER_REPEAT`.
@MainActor
final class OfferThrottle {
  private var shown = Set<String>()
  private var offeredAt: [String: Date] = [:]

  init() {}

  /// Whether to show `offer` for `ref` now; records it when so.
  func shouldShow(_ offer: PlaceOffer, for ref: BookRef, now: Date) -> Bool {
    let shownKey = "\(ref.key)|\(offer.key)"
    if shown.contains(shownKey) { return false }
    let device = offer.key.lastIndex(of: "|").map { String(offer.key[..<$0]) } ?? offer.key
    let deviceKey = "\(ref.key)|\(device)"
    if let last = offeredAt[deviceKey], now.timeIntervalSince(last) < Offers.OFFER_REPEAT { return false }
    shown.insert(shownKey)
    offeredAt[deviceKey] = now
    return true
  }
}
