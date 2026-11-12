// Books the phone sent that the watch cannot take yet, a port of targets/watch/Core/HeldBooks.swift.
// A DataItem wakes the watch whenever it is near, so a book arriving during its sign-in, after that
// sign-in failed, or for an account the watch does not hold is a normal case, and the phone has
// already said "Sent". Each one waits here, on disk, until its account reaches ready; the phone's
// "Send again" is the way out of a failed sign-in. One that can no longer come (too old, over the
// cap, its account refused) is given up on and kept a while, so it is seen rather than lost
// silently. An account the watch has left takes its rows with it.
//
// `watch-state` has no account per book: its books read as the account it names. So a row is
// reported only under its own account, and the watch's own screens show the rest.
//
// A `remove` is handled in its turn (a sign-in may run ahead of it), but a book is held the moment
// it arrives, so a book sent again right after a `remove` is already here when that turn comes. The
// ticket keeps them apart: a `remove` clears only the row it arrived after, and until it is handled
// a book's record, about to go, settles no row.
package app.audiosilo.wear.core

import java.io.File
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

@Serializable
data class HeldBook(
  val book: BookMessage,
  /** When it last arrived: a book sent again waits afresh. */
  val heldAt: StoredInstant,
  /** When it was given up on; null while it waits. */
  val gaveUpAt: StoredInstant? = null,
) {
  val id: String
    get() = "${book.accountId}|${book.ref.key}"

  val waiting: Boolean
    get() = gaveUpAt == null
}

/** A `remove` from when it arrived until its turn: the row it found then, if any. */
data class RemoveTicket(val message: RemoveMessage, val row: HeldBook?)

/** Thread-safe. */
class HeldBooks(file: File?) {
  private val file = file?.let { JsonFile(it, ListSerializer(HeldBook.serializer())) }

  /** In the order they arrived. */
  var books: List<HeldBook> = this.file?.read() ?: emptyList()
    @Synchronized get
    private set

  /**
   * The books of the `remove`s not handled yet. Not on disk: they arrived with the app running and
   * go with it, and the phone's row offers Remove again.
   */
  private val removing = ArrayList<BookRef>()

  /** Keep a book until it is on the watch. Sent again, it replaces its earlier row and waits afresh. */
  @Synchronized
  fun hold(book: BookMessage, now: Instant) {
    val row = HeldBook(book, now)
    commit(books.filter { it.id != row.id } + row, now)
  }

  /**
   * The books to queue now: those waiting for `accountId`, once it is ready. Their rows stay until
   * `settle` sees them on the watch, so a kill between the two loses nothing.
   */
  @Synchronized
  fun due(accountId: String?, ready: Boolean, now: Instant): List<BookMessage> {
    commit(books, now)
    if (!ready) return emptyList()
    return books.filter { it.waiting && it.book.accountId == accountId }.map { it.book }
  }

  /**
   * Age what is here and forget what `accountId` now has on the watch (`onWatch`, whichever way it
   * got there: nothing is left to hold, or to report as not delivered).
   */
  @Synchronized
  fun settle(accountId: String?, onWatch: List<BookRef>, now: Instant) {
    if (books.isEmpty()) return
    val here = onWatch.toSet() - removing.toSet()
    commit(books.filter { !(it.book.accountId == accountId && it.book.ref in here) }, now)
  }

  /**
   * The watch has left this account (sign-out, a replace that succeeded): all its rows go, given up
   * on or not. Never for a sign-in that is blocked or failed: those can still end here.
   */
  @Synchronized
  fun forget(accountId: String?, now: Instant) {
    commit(books.filter { it.book.accountId != accountId }, now)
  }

  /** The listener refused this account (Keep this account): its books can't come. */
  @Synchronized
  fun giveUp(accountId: String, now: Instant) {
    commit(
      books.map { if (it.waiting && it.book.accountId == accountId) it.copy(gaveUpAt = now) else it },
      now,
    )
  }

  /** A `remove` arrived: note it, and which row it is about, for when its turn comes. */
  @Synchronized
  fun noteRemove(message: RemoveMessage): RemoveTicket {
    removing += message.ref
    val row = books.firstOrNull { it.book.accountId == message.accountId && it.book.ref == message.ref }
    return RemoveTicket(message, row)
  }

  /**
   * A `remove`'s turn, with the watch signed in to `accountId`: true when the book goes too, which
   * `takeBook` sees to. Its own account only: signed out or on another account nothing changes. The
   * row it found goes, waiting or given up on; one sent again since has another `heldAt`, and stays.
   * The ticket closes only after `takeBook`: stopping a playing book publishes with its record still
   * here, and that must settle no row.
   */
  @Synchronized
  fun finishRemove(ticket: RemoveTicket, accountId: String?, now: Instant, takeBook: () -> Unit = {}): Boolean {
    try {
      if (ticket.message.accountId != accountId) return false
      val row = ticket.row
      if (row != null) commit(books.filter { !(it.id == row.id && it.heldAt == row.heldAt) }, now)
      takeBook()
      return true
    } finally {
      removing.remove(ticket.message.ref)
    }
  }

  /** The rows for `watch-state`, which names `accountId` (signed out names none, so none). */
  @Synchronized
  fun stateRows(accountId: String?): List<WatchStateBook> =
    books
      .filter { it.book.accountId == accountId }
      .map {
        WatchStateBook(
          it.book.ref,
          it.book.title,
          if (it.waiting) WatchStateBook.State.QUEUED else WatchStateBook.State.FAILED,
          null,
        )
      }

  /** Apply the age and the caps, and write only a real change. */
  private fun commit(next: List<HeldBook>, now: Instant) {
    val aged =
      next.mapNotNull { row ->
        val gaveUpAt = row.gaveUpAt
        when {
          gaveUpAt != null -> if (now.secondsSince(gaveUpAt) >= GAVE_UP_KEEP) null else row
          now.secondsSince(row.heldAt) >= MAX_AGE -> row.copy(gaveUpAt = now)
          else -> row
        }
      }
    val waitingIndices = aged.indices.filter { aged[it].waiting }
    val overCap = waitingIndices.dropLast(MAX_BOOKS).toSet()
    val capped = aged.mapIndexed { i, row -> if (i in overCap) row.copy(gaveUpAt = now) else row }
    val gaveUp = capped.filter { it.gaveUpAt != null }.sortedBy { it.gaveUpAt }
    val dropped = gaveUp.dropLast(MAX_BOOKS).map { it.id }.toSet()
    val rows = capped.filter { it.id !in dropped }
    if (rows == books) return
    books = rows
    file?.write(rows.ifEmpty { null })
  }

  companion object {
    /**
     * How many books wait at once, and how many given up on are kept. The listener sends books one
     * by one by hand, so more than this is a loop or a mistake; the oldest waiting is given up on.
     */
    const val MAX_BOOKS = 20

    /** How long a book waits for its account (past this, a download starting by itself would surprise). */
    const val MAX_AGE: Double = 7.0 * 24 * 60 * 60

    /** How long a book given up on stays visible. */
    const val GAVE_UP_KEEP: Double = 7.0 * 24 * 60 * 60

    /**
     * The rows Home lists as on their way: those still waiting, less one of this account's beside a
     * record of it (it speaks for that record until it settles, and the record has the detail).
     */
    fun waiting(rows: List<HeldBook>, accountId: String?, records: List<BookRef>): List<HeldBook> {
      val here = records.toSet()
      return rows.filter { it.waiting && !(it.book.accountId == accountId && it.book.ref in here) }
    }
  }
}
