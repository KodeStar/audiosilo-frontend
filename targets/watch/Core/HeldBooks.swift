// Books the phone sent that the watch cannot take yet. `transferUserInfo` delivers in the
// background, so a book arriving during its sign-in, after that sign-in failed, or for an account
// the watch does not hold is a normal case, and the phone has already said "Sent". Each one waits
// here, on disk, until its account reaches ready; the phone's "Send again" is the way out of a
// failed sign-in. One that can no longer come (too old, over the cap, its account left or refused)
// is given up on and kept a while, so it is seen rather than lost silently.
//
// `watch-state` has no account per book: its books read as the account it names. So a row is
// reported only under its own account, and the watch's own screens show the rest.
import Foundation

struct HeldBook: Codable, Equatable, Identifiable, Sendable {
  var book: BookMessage
  /// When it last arrived: a book sent again waits afresh.
  var heldAt: Date
  /// When it was given up on; nil while it waits.
  var gaveUpAt: Date?

  var id: String { "\(book.accountId)|\(book.ref.key)" }
  var waiting: Bool { gaveUpAt == nil }
}

final class HeldBooks {
  /// How many books wait at once, and how many given up on are kept. The listener sends books one
  /// by one by hand, so more than this is a loop or a mistake; the oldest waiting is given up on.
  static let MAX_BOOKS = 20
  /// How long a book waits for its account: past this the listener has likely moved on, and a
  /// download starting by itself would be a surprise.
  static let MAX_AGE: TimeInterval = 7 * 24 * 60 * 60
  /// How long a book given up on stays visible.
  static let GAVE_UP_KEEP: TimeInterval = 7 * 24 * 60 * 60

  private let file: JSONFile<[HeldBook]>?
  /// In the order they arrived.
  private(set) var books: [HeldBook]

  /// `url` nil keeps them in memory (tests).
  init(url: URL?) {
    file = url.map { JSONFile(url: $0) }
    books = file?.read() ?? []
  }

  /// Whether a book can be queued now rather than held: signed in to its account and ready.
  static func accepts(_ book: BookMessage, accountId: String?, ready: Bool) -> Bool {
    ready && accountId == book.accountId
  }

  /// Keep a book that can't be accepted yet. Sent again, it replaces its earlier row (one given up
  /// on too) and waits afresh.
  func hold(_ book: BookMessage, now: Date) {
    let row = HeldBook(book: book, heldAt: now)
    commit(books.filter { $0.id != row.id } + [row], now: now)
  }

  /// The books to queue now: those waiting for `accountId`, once it is ready. Their rows stay until
  /// `settle` sees them on the watch, so a kill between the two loses nothing.
  func due(accountId: String?, ready: Bool, now: Date) -> [BookMessage] {
    commit(books, now: now)
    guard ready, let accountId else { return [] }
    return books.filter { $0.waiting && $0.book.accountId == accountId }.map(\.book)
  }

  /// Age what is here and forget what `accountId` now has on the watch (`onWatch`, whichever way it
  /// got there: nothing is left to hold, or to report as not delivered).
  func settle(accountId: String?, onWatch: [BookRef], now: Date) {
    let here = Set(onWatch)
    commit(books.filter { !($0.book.accountId == accountId && here.contains($0.book.ref)) }, now: now)
  }

  /// The watch has definitely left this account, or the listener refused it: its books can't come.
  /// Never for a sign-in that is blocked or failed: those can still end on this account.
  func giveUp(accountId: String?, now: Date) {
    commit(books.map { row in
      guard row.waiting, row.book.accountId == accountId else { return row }
      var gaveUp = row
      gaveUp.gaveUpAt = now
      return gaveUp
    }, now: now)
  }

  /// The rows for `watch-state`, which names `accountId` (signed out names none, so none).
  func stateRows(accountId: String?) -> [WatchStateBook] {
    books.filter { $0.book.accountId == accountId }.map {
      WatchStateBook(ref: $0.book.ref, title: $0.book.title, state: $0.waiting ? .queued : .failed, bytes: nil)
    }
  }

  /// Apply the age and the caps, and write only a real change.
  private func commit(_ next: [HeldBook], now: Date) {
    var rows: [HeldBook] = next.compactMap { row in
      var row = row
      if let gaveUpAt = row.gaveUpAt {
        return now.timeIntervalSince(gaveUpAt) >= Self.GAVE_UP_KEEP ? nil : row
      }
      if now.timeIntervalSince(row.heldAt) >= Self.MAX_AGE { row.gaveUpAt = now }
      return row
    }
    var over = rows.filter(\.waiting).count - Self.MAX_BOOKS
    for i in rows.indices where over > 0 && rows[i].waiting {
      rows[i].gaveUpAt = now
      over -= 1
    }
    let gaveUp = rows.filter { !$0.waiting }.sorted { ($0.gaveUpAt ?? now) < ($1.gaveUpAt ?? now) }
    if gaveUp.count > Self.MAX_BOOKS {
      let dropped = Set(gaveUp.prefix(gaveUp.count - Self.MAX_BOOKS).map(\.id))
      rows.removeAll { dropped.contains($0.id) }
    }
    guard rows != books else { return }
    books = rows
    file?.write(rows.isEmpty ? nil : rows)
  }
}
