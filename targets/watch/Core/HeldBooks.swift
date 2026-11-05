// Books the phone sent that the watch cannot take yet. `transferUserInfo` delivers in the
// background, so a book arriving during its sign-in, after that sign-in failed, or for an account
// the watch does not hold is a normal case, and the phone has already said "Sent". Each one waits
// here, on disk, until its account reaches ready; the phone's "Send again" is the way out of a
// failed sign-in. One that can no longer come (too old, over the cap, its account refused) is given
// up on and kept a while, so it is seen rather than lost silently. An account the watch has left
// takes its rows with it, so no titles of that account stay on the watch's screens.
//
// `watch-state` has no account per book: its books read as the account it names. So a row is
// reported only under its own account, and the watch's own screens show the rest.
//
// A `remove` is handled in its turn (a sign-in may run ahead of it), but a book is held the moment
// it arrives, so a book sent again right after a `remove` is already here when that turn comes.
// The ticket keeps them apart: a `remove` clears only the row it arrived after, and until it is
// handled a book's record, about to go, settles no row.
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

/// A `remove` from when it arrived until its turn: the row it found then, if any.
struct RemoveTicket: Equatable, Sendable {
  var message: RemoveMessage
  var row: HeldBook?
}

@MainActor
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
  /// The books of the `remove`s not handled yet. Not on disk: they arrived with the app running
  /// and go with it, and the phone stops saying "removing" after 7 days and offers it again.
  private var removing: [BookRef] = []

  /// `url` nil keeps them in memory (tests).
  init(url: URL?) {
    file = url.map { JSONFile(url: $0) }
    books = file?.read() ?? []
  }

  /// Keep a book until it is on the watch. Sent again, it replaces its earlier row (one given up on
  /// too) and waits afresh.
  func hold(_ book: BookMessage, now: Date) {
    let row = HeldBook(book: book, heldAt: now)
    commit(books.filter { $0.id != row.id } + [row], now: now)
  }

  /// The books to queue now: those waiting for `accountId`, once it is ready. Their rows stay until
  /// `settle` sees them on the watch, so a kill between the two loses nothing.
  func due(accountId: String?, ready: Bool, now: Date) -> [BookMessage] {
    commit(books, now: now)
    guard ready else { return [] }
    return books.filter { $0.waiting && $0.book.accountId == accountId }.map(\.book)
  }

  /// Age what is here and forget what `accountId` now has on the watch (`onWatch`, whichever way it
  /// got there: nothing is left to hold, or to report as not delivered).
  func settle(accountId: String?, onWatch: [BookRef], now: Date) {
    guard !books.isEmpty else { return }
    let here = Set(onWatch).subtracting(removing)
    commit(books.filter { !($0.book.accountId == accountId && here.contains($0.book.ref)) }, now: now)
  }

  /// The watch has left this account (sign-out, a replace that succeeded): all its rows go, given
  /// up on or not. Never for a sign-in that is blocked or failed: those can still end here.
  func forget(accountId: String?, now: Date) {
    commit(books.filter { $0.book.accountId != accountId }, now: now)
  }

  /// The listener refused this account (Keep this account): its books can't come.
  func giveUp(accountId: String, now: Date) {
    var rows = books
    for i in rows.indices where rows[i].waiting && rows[i].book.accountId == accountId {
      rows[i].gaveUpAt = now
    }
    commit(rows, now: now)
  }

  /// A `remove` arrived: note it, and which row it is about, for when its turn comes.
  func noteRemove(_ message: RemoveMessage) -> RemoveTicket {
    removing.append(message.ref)
    let row = books.first { $0.book.accountId == message.accountId && $0.book.ref == message.ref }
    return RemoveTicket(message: message, row: row)
  }

  /// A `remove`'s turn, with the watch signed in to `accountId`: true when the book goes too, which
  /// `takeBook` sees to. Its own account only: signed out or on another account nothing changes, so
  /// its book still comes if that account signs in, as the phone's row says. The row it found goes,
  /// waiting or given up on; one sent again since has another `heldAt`, and stays. The ticket closes
  /// only after `takeBook`: stopping a playing book publishes with its record still here, and that
  /// must settle no row.
  @discardableResult
  func finishRemove(_ ticket: RemoveTicket, accountId: String?, now: Date, takeBook: () -> Void = {}) -> Bool {
    defer { if let i = removing.firstIndex(of: ticket.message.ref) { removing.remove(at: i) } }
    guard ticket.message.accountId == accountId else { return false }
    if let row = ticket.row {
      commit(books.filter { !($0.id == row.id && $0.heldAt == row.heldAt) }, now: now)
    }
    takeBook()
    return true
  }

  /// The rows Home lists as on their way: those still waiting, less one of this account's beside
  /// a record of it (it speaks for that record until it settles, and the record has the detail).
  static func waiting(_ rows: [HeldBook], accountId: String?, records: [BookRef]) -> [HeldBook] {
    let here = Set(records)
    return rows.filter { $0.waiting && !($0.book.accountId == accountId && here.contains($0.book.ref)) }
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
    for i in rows.indices.filter({ rows[$0].waiting }).dropLast(Self.MAX_BOOKS) { rows[i].gaveUpAt = now }
    let gaveUp = rows.compactMap { row in row.gaveUpAt.map { (at: $0, id: row.id) } }.sorted { $0.at < $1.at }
    let dropped = Set(gaveUp.dropLast(Self.MAX_BOOKS).map(\.id))
    rows.removeAll { dropped.contains($0.id) }
    guard rows != books else { return }
    books = rows
    file?.write(rows.isEmpty ? nil : rows)
  }
}
