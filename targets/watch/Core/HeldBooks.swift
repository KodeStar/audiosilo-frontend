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
// handled a book's record, about to go, settles no row. Tickets are kept in the same file (fe#219),
// so a kill before their turn loses none: those read at launch are handed out once an account is
// there to finish them (`takeLeftoverRemoves`).
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
struct RemoveTicket: Codable, Equatable, Identifiable, Sendable {
  var id = UUID()
  var message: RemoveMessage
  var row: HeldBook?
  /// When it arrived: one older than `HeldBooks.MAX_AGE` is dropped (the phone has stopped saying
  /// "removing" by then).
  var arrivedAt: Date
}

/// `held-books.json`: the books, then the `remove`s not handled yet. Before 2.7.0 it held the books
/// alone, as an array, which still reads.
struct HeldFile: Codable, Equatable {
  var books: [HeldBook]
  var removes: [RemoveTicket]
}

extension HeldFile {
  init(from decoder: Decoder) throws {
    if let books = try? decoder.singleValueContainer().decode([HeldBook].self) {
      self.init(books: books, removes: [])
      return
    }
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(books: try c.decode([HeldBook].self, forKey: .books),
              removes: try c.decodeIfPresent([RemoveTicket].self, forKey: .removes) ?? [])
  }
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

  private let file: JSONFile<HeldFile>?
  /// In the order they arrived.
  private(set) var books: [HeldBook]
  /// The `remove`s not handled yet, in the order they arrived.
  private(set) var removes: [RemoveTicket]
  /// The ids of those read at launch and not handed out yet (`takeLeftoverRemoves`).
  private var leftover: Set<UUID>

  /// The file could not be read (before the watch's first unlock): nothing is written over it
  /// until `reload` has read it.
  private var unread = false
  /// The last write failed: before the first unlock no file can be written, a missing one
  /// included, so what arrived then is in memory alone until `reload` writes it.
  private var unsaved = false

  /// `url` nil keeps them in memory (tests).
  init(url: URL?) {
    file = url.map { JSONFile(url: $0) }
    books = []
    removes = []
    leftover = []
    read()
  }

  /// Read the file again after a launch that could not (`AppModel.catchUp`): what it keeps joins
  /// what arrived meanwhile (which wins: a book sent again replaces its row), and every `remove` not
  /// handled yet is left over, finished once an account is there (`takeLeftoverRemoves`). What a
  /// failed write left in memory alone is written again.
  func reload() {
    if unread {
      let arrived = !books.isEmpty || !removes.isEmpty
      read()
      if arrived { save() }
    } else if unsaved {
      save()
    }
  }

  private func read() {
    let kept: HeldFile?
    switch file?.load() {
    case .unreadable:
      unread = true
      return
    case .value(let v): kept = v
    default: kept = nil  // none, or damaged: started afresh
    }
    unread = false
    let keptBooks = kept?.books ?? []
    let mine = Set(books.map(\.id))
    let noted = Set(removes.map(\.id))
    // A `remove` that came while the file could not be read found none of its rows, but the row
    // it is about was there when it came.
    let came = removes.map { ticket in
      guard ticket.row == nil else { return ticket }
      var t = ticket
      t.row = keptBooks.first { $0.book.accountId == t.message.accountId && $0.book.ref == t.message.ref }
      return t
    }
    books = keptBooks.filter { !mine.contains($0.id) } + books
    removes = (kept?.removes ?? []).filter { !noted.contains($0.id) } + came
    leftover = Set(removes.map(\.id))
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
  /// got there: nothing is left to hold, or to report as not delivered). Returns the books settled
  /// so, still waiting: each was asked for again, which its record takes as when it was added
  /// (`DownloadManager.noteAsked`), or a Remove asked before this Send would take it.
  @discardableResult
  func settle(accountId: String?, onWatch: [BookRef], now: Date) -> [BookMessage] {
    guard !books.isEmpty || !removes.isEmpty else { return [] }
    let here = Set(onWatch).subtracting(removes.map(\.message.ref))
    let settles = { (row: HeldBook) in row.book.accountId == accountId && here.contains(row.book.ref) }
    let settled = books.filter { settles($0) && $0.waiting }.map(\.book)
    commit(books.filter { !settles($0) }, now: now)
    return settled
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

  /// A `remove` arrived: note it, on disk, and which row it is about, for when its turn comes.
  func noteRemove(_ message: RemoveMessage, now: Date) -> RemoveTicket {
    let row = books.first { $0.book.accountId == message.accountId && $0.book.ref == message.ref }
    let ticket = RemoveTicket(message: message, row: row, arrivedAt: now)
    commit(books, removes: removes + [ticket], now: now)
    return ticket
  }

  /// The `remove`s a kill left on disk, once: the caller finishes each in its turn, with an account
  /// signed in (signed out, it would only refuse them, and the account may just not be read yet).
  func takeLeftoverRemoves() -> [RemoveTicket] {
    let out = removes.filter { leftover.contains($0.id) }
    leftover = []
    return out
  }

  /// A `remove`'s turn, with the watch signed in to `accountId`: true when the book goes too, which
  /// `takeBook` sees to (only a copy the `remove` covers: `RemoveMessage.covers`). Its own account
  /// only: signed out or on another account nothing changes, so its book still comes if that account
  /// signs in, as the phone's row says. The row it found goes, waiting or given up on, unless it was
  /// asked for after the `remove` was; one sent again since has another `heldAt`, and stays. The
  /// ticket closes only after `takeBook`: stopping a playing book publishes with its record still
  /// here, and that must settle no row.
  @discardableResult
  func finishRemove(_ ticket: RemoveTicket, accountId: String?, now: Date, takeBook: () -> Void = {}) -> Bool {
    defer { commit(books, removes: removes.filter { $0.id != ticket.id }, now: now) }
    guard ticket.message.accountId == accountId else { return false }
    if let row = ticket.row, ticket.message.covers(addedAt: row.book.askedAt) {
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
      WatchStateBook(ref: $0.book.ref, title: $0.book.title, state: $0.waiting ? .queued : .failed, bytes: nil,
                     addedAt: $0.book.askedAt ?? $0.heldAt)
    }
  }

  /// Apply the age and the caps, and write only a real change.
  private func commit(_ next: [HeldBook], now: Date) {
    commit(next, removes: removes, now: now)
  }

  private func commit(_ next: [HeldBook], removes nextRemoves: [RemoveTicket], now: Date) {
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
    let tickets = nextRemoves.filter { now.timeIntervalSince($0.arrivedAt) < Self.MAX_AGE }
    guard rows != books || tickets != removes else { return }
    books = rows
    removes = tickets
    save()
  }

  private func save() {
    guard !unread, let file else { return }
    unsaved = !file.write(books.isEmpty && removes.isEmpty ? nil : HeldFile(books: books, removes: removes))
  }
}
