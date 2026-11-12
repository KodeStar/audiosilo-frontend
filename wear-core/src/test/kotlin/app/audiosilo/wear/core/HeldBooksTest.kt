// Ported from watch-core/Tests/WatchCoreTests/HeldBooksTests.swift and StatePublicationTests.swift:
// a book the phone sent that the watch can't take yet (held, released on ready, aged, capped, kept
// across a kill, never silent when it can't come), and when `watch-state` goes to the phone.
package app.audiosilo.wear.core

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

private val t0 = instantAt(1_800_000_000.0)
private const val A = "srv-a.1"
private const val B = "srv-b.2"

private fun bookA(path: String = "A/One", title: String = "One") =
  BookMessage("srv-a", 1, BookRef(1, path), title, "Ann")

private fun bookB(path: String = "B/One", title: String = "One") =
  BookMessage("srv-b", 2, BookRef(1, path), title, null)

class HeldBooksTest {
  private val dirs = ArrayList<File>()

  private fun tempFile(): File {
    val dir = tempDir()
    dirs += dir
    return File(dir, "held-books.json")
  }

  @After
  fun tearDown() {
    dirs.forEach { it.deleteRecursively() }
  }

  // Held, then released

  @Test
  fun heldThenReleasedOnReady() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    assertEquals("still signing in", emptyList<BookMessage>(), held.due(null, false, t0))
    assertEquals("signed in, not ready (too old)", emptyList<BookMessage>(), held.due(A, false, t0))
    assertEquals(listOf(bookA()), held.due(A, true, t0))
    assertEquals("kept until it is on the watch", 1, held.books.size)
    held.settle(A, listOf(bookA().ref), t0)
    assertEquals(emptyList<HeldBook>(), held.books)
    assertEquals(emptyList<BookMessage>(), held.due(A, true, t0))
  }

  @Test
  fun releasesInTheOrderTheyCame() {
    val held = HeldBooks(null)
    held.hold(bookA("A/One"), t0)
    held.hold(bookB(), t0)
    held.hold(bookA("A/Two"), t0)
    assertEquals(listOf("A/One", "A/Two"), held.due(A, true, t0).map { it.ref.path })
  }

  @Test
  fun aKillBetweenQueueingAndSettlingLosesNothing() {
    val file = tempFile()
    val held = HeldBooks(file)
    held.hold(bookA(), t0)
    assertEquals(listOf(bookA()), held.due(A, true, t0))
    // Killed before the download index said so: the next launch has it to release again.
    assertEquals(listOf(bookA()), HeldBooks(file).due(A, true, t0))
  }

  // A failed pair

  @Test
  fun aFailedPairKeepsTheBookForTheNextSendAgain() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    // The exchange failed: nothing happens to the book, and no account or ready came of it.
    val later = t0.addingSeconds(3600.0)
    assertEquals(emptyList<BookMessage>(), held.due(null, false, later))
    assertTrue("a failed sign-in is not a definite end", held.books[0].waiting)
    // Send again from the phone: this one succeeded.
    assertEquals(listOf(bookA()), held.due(A, true, later))
  }

  @Test
  fun aFailedPairNeverSignedInAgesOutVisibly() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    val past = t0.addingSeconds(HeldBooks.MAX_AGE)
    assertEquals("too old to start by itself", emptyList<BookMessage>(), held.due(A, true, past))
    assertEquals(listOf(false), held.books.map { it.waiting })
    assertEquals(listOf(WatchStateBook.State.FAILED), held.stateRows(A).map { it.state })
  }

  // The wrong account

  @Test
  fun anotherAccountsBookStaysHeldThenAgesOut() {
    val held = HeldBooks(null)
    held.hold(bookB(), t0)
    assertEquals("signed in to another account", emptyList<BookMessage>(), held.due(A, true, t0))
    val justBefore = t0.addingSeconds(HeldBooks.MAX_AGE - 1)
    held.settle(A, emptyList(), justBefore)
    assertTrue(held.books[0].waiting)
    assertEquals("its account came in time", listOf(bookB()), held.due(B, true, justBefore))
    held.settle(A, emptyList(), t0.addingSeconds(HeldBooks.MAX_AGE))
    assertFalse(held.books[0].waiting)
    assertEquals(emptyList<BookMessage>(), held.due(B, true, t0.addingSeconds(HeldBooks.MAX_AGE)))
  }

  @Test
  fun givingUpTouchesOnlyThatAccount() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    held.hold(bookB(), t0)
    held.giveUp(A, t0)
    assertEquals(listOf(false, true), held.books.map { it.waiting })
    assertEquals("a book given up on is not released", emptyList<BookMessage>(), held.due(A, true, t0))
    assertEquals(listOf(bookB()), held.due(B, true, t0))
  }

  @Test
  fun leavingAnAccountDeletesItsRowsWaitingOrGivenUpOn() {
    val held = HeldBooks(null)
    held.hold(bookA("A/Waiting"), t0)
    held.hold(bookA("A/GivenUp"), t0.addingSeconds(-HeldBooks.MAX_AGE))
    held.settle(null, emptyList(), t0)
    held.hold(bookB(), t0)
    assertEquals(listOf("A/GivenUp"), held.books.filter { !it.waiting }.map { it.book.ref.path })
    held.forget(A, t0)
    assertEquals("only the account left", listOf(bookB()), held.books.map { it.book })
    assertTrue(held.books[0].waiting)
    assertEquals(emptyList<WatchStateBook>(), held.stateRows(A))
  }

  @Test
  fun leavingWithNoAccountTouchesNothing() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    held.forget(null, t0)
    assertEquals(1, held.books.size)
  }

  @Test
  fun theSamePathOnAnotherServerIsAnotherBook() {
    val held = HeldBooks(null)
    val sameRef = BookMessage("srv-b", 2, bookA().ref, "Other", null)
    held.hold(bookA(), t0)
    held.hold(sameRef, t0)
    assertEquals(2, held.books.size)
    held.settle(A, listOf(bookA().ref), t0)
    assertEquals("only the signed-in account's book is on the watch", listOf(sameRef), held.books.map { it.book })
  }

  // Age

  @Test
  fun aGivenUpBookIsForgottenAfterItsKeep() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    held.giveUp(A, t0)
    held.settle(null, emptyList(), t0.addingSeconds(HeldBooks.GAVE_UP_KEEP - 1))
    assertEquals(1, held.books.size)
    held.settle(null, emptyList(), t0.addingSeconds(HeldBooks.GAVE_UP_KEEP))
    assertEquals(emptyList<HeldBook>(), held.books)
  }

  // The cap

  @Test
  fun overTheCapTheOldestWaitingIsGivenUpOnNotLostSilently() {
    val held = HeldBooks(null)
    for (i in 0 until HeldBooks.MAX_BOOKS) held.hold(bookA("A/$i"), t0.addingSeconds(i.toDouble()))
    assertTrue(held.books.all { it.waiting })
    held.hold(bookA("A/new"), t0.addingSeconds(100.0))
    val waiting = held.books.filter { it.waiting }
    assertEquals(HeldBooks.MAX_BOOKS, waiting.size)
    assertFalse(waiting.any { it.book.ref.path == "A/0" })
    assertTrue("the newest is what was just asked for", waiting.any { it.book.ref.path == "A/new" })
    val failed = held.stateRows(A).filter { it.state == WatchStateBook.State.FAILED }
    assertEquals(listOf("A/0"), failed.map { it.ref.path })
  }

  @Test
  fun booksGivenUpOnAreCappedTooOldestFirst() {
    val held = HeldBooks(null)
    for (i in 0 until HeldBooks.MAX_BOOKS + 1) {
      val at = t0.addingSeconds(i.toDouble())
      held.hold(bookA("A/$i"), at)
      held.giveUp(A, at)
    }
    assertEquals(HeldBooks.MAX_BOOKS, held.books.size)
    assertFalse(held.books.any { it.book.ref.path == "A/0" })
    assertTrue(held.books.any { it.book.ref.path == "A/${HeldBooks.MAX_BOOKS}" })
  }

  // Duplicates

  @Test
  fun theSameBookAgainIsOneRowAndWaitsAfresh() {
    val held = HeldBooks(null)
    held.hold(bookA(title = "Old title"), t0)
    val later = t0.addingSeconds(HeldBooks.MAX_AGE - 1)
    held.hold(bookA(title = "New title"), later)
    assertEquals(1, held.books.size)
    assertEquals("New title", held.books[0].book.title)
    assertEquals(1, held.due(A, true, t0.addingSeconds(HeldBooks.MAX_AGE)).size)
  }

  @Test
  fun aGivenUpBookSentAgainWaitsAgain() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    held.giveUp(A, t0)
    held.hold(bookA(), t0.addingSeconds(10.0))
    assertEquals(listOf(true), held.books.map { it.waiting })
    assertEquals(listOf(WatchStateBook.State.QUEUED), held.stateRows(A).map { it.state })
  }

  @Test
  fun aBookAlreadyOnTheWatchIsNoLongerHeldOrReported() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    held.giveUp(A, t0)
    // Downloaded another way (the watch's own button, or sent again once ready).
    held.settle(A, listOf(bookA().ref), t0)
    assertEquals(emptyList<WatchStateBook>(), held.stateRows(A))
  }

  // watch-state

  @Test
  fun reportsQueuedThenFailedWithNoBytes() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    assertEquals(listOf(WatchStateBook(bookA().ref, "One", WatchStateBook.State.QUEUED, null)), held.stateRows(A))
    held.giveUp(A, t0)
    assertEquals(listOf(WatchStateBook(bookA().ref, "One", WatchStateBook.State.FAILED, null)), held.stateRows(A))
  }

  // Its books read as the account the state names, so another's would be listed under the wrong one.
  @Test
  fun reportsARowOnlyUnderItsOwnAccount() {
    val held = HeldBooks(null)
    held.hold(bookB(), t0)
    assertEquals(emptyList<WatchStateBook>(), held.stateRows(A))
    assertEquals(emptyList<WatchStateBook>(), held.stateRows(null))
    assertEquals(1, held.stateRows(B).size)
  }

  @Test
  fun theRowsFitTheMessageWithNoNewField() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    held.giveUp(A, t0)
    val state = WatchState(true, "srv-a", 1, "2.6.0", held.stateRows(A), 0, 0, null)
    val books = PhoneMessages.encode(state)["books"]!!.jsonArray
    val first = books[0].jsonObject
    assertEquals("failed", first["state"]?.jsonPrimitive?.content)
    assertEquals(setOf("library_id", "path", "title", "state"), first.keys)
  }

  // Across a kill

  @Test
  fun persistenceRoundTrip() {
    val file = tempFile()
    val held = HeldBooks(file)
    held.hold(bookA(), t0)
    held.hold(bookB(), t0.addingSeconds(5.0))
    held.giveUp(B, t0.addingSeconds(6.0))
    val again = HeldBooks(file)
    assertEquals(held.books, again.books)
    assertEquals("Ann", again.books[0].book.author)
    assertEquals(t0.addingSeconds(6.0), again.books[1].gaveUpAt)
    assertEquals(listOf(bookA()), again.due(A, true, t0))
  }

  @Test
  fun theAgeCarriesAcrossAKill() {
    val file = tempFile()
    HeldBooks(file).hold(bookA(), t0)
    val again = HeldBooks(file)
    assertEquals(emptyList<BookMessage>(), again.due(A, true, t0.addingSeconds(HeldBooks.MAX_AGE)))
    assertEquals(listOf(WatchStateBook.State.FAILED), HeldBooks(file).stateRows(A).map { it.state })
  }

  @Test
  fun theFileGoesWhenNothingIsLeft() {
    val file = tempFile()
    val held = HeldBooks(file)
    held.hold(bookA(), t0)
    assertTrue(file.exists())
    held.settle(A, listOf(bookA().ref), t0)
    assertFalse(file.exists())
  }

  // What the state publication asks before it lets a row go for a download record.
  @Test
  fun aWriteSaysWhetherItLanded() {
    val file = tempFile()
    val json = JsonFile(file, ListSerializer(String.serializer()))
    assertTrue(json.write(listOf("one")))
    assertTrue(json.write(null))
    // A file where its folder should be: nothing can land there.
    file.writeBytes(ByteArray(0))
    assertFalse(JsonFile(File(file, "under"), ListSerializer(String.serializer())).write(listOf("one")))
  }

  @Test
  fun anUnreadableFileReadsAsNothing() {
    val file = tempFile()
    file.writeText("not json")
    assertEquals(emptyList<HeldBook>(), HeldBooks(file).books)
  }

  // remove

  private fun removeA(path: String = "A/One") = RemoveMessage("srv-a", 1, BookRef(1, path))

  @Test
  fun removeForTheSignedInAccountGoesAndClearsItsRow() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    val ticket = held.noteRemove(removeA())
    assertTrue(held.finishRemove(ticket, A, t0))
    assertEquals(emptyList<HeldBook>(), held.books)
    assertEquals("it never starts", emptyList<BookMessage>(), held.due(A, true, t0))
  }

  @Test
  fun removeClearsARowGivenUpOn() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    held.giveUp(A, t0)
    assertEquals(listOf(WatchStateBook.State.FAILED), held.stateRows(A).map { it.state })
    assertTrue(held.finishRemove(held.noteRemove(removeA()), A, t0))
    assertEquals(emptyList<WatchStateBook>(), held.stateRows(A))
  }

  @Test
  fun removeWithNoRowStillTakesTheBook() {
    val held = HeldBooks(null)
    assertTrue(held.finishRemove(held.noteRemove(removeA()), A, t0))
  }

  @Test
  fun aRepeatedRemoveChangesNothingMore() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    held.hold(bookA("A/Two"), t0)
    assertTrue(held.finishRemove(held.noteRemove(removeA()), A, t0))
    val left = held.books
    // The phone's Remove again, when the first did get here.
    assertTrue(held.finishRemove(held.noteRemove(removeA()), A, t0))
    assertEquals(left, held.books)
  }

  @Test
  fun aBookSentBehindARepeatedRemoveStands() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    val first = held.noteRemove(removeA())
    val repeated = held.noteRemove(removeA())
    val later = t0.addingSeconds(1.0)
    held.hold(bookA(), later)
    assertTrue(held.finishRemove(first, A, later))
    // The repeat is still to come, so the record it is about settles no row yet.
    held.settle(A, listOf(bookA().ref), later)
    assertTrue(held.finishRemove(repeated, A, later))
    assertEquals(listOf(bookA()), held.due(A, true, later))
    held.settle(A, listOf(bookA().ref), later)
    assertEquals("both turns over, the record speaks for it again", emptyList<HeldBook>(), held.books)
  }

  @Test
  fun removeIsRefusedSignedOutOrOnAnotherAccountAndChangesNothing() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    assertFalse("signed out", held.finishRemove(held.noteRemove(removeA()), null, t0))
    assertFalse("another account", held.finishRemove(held.noteRemove(removeA()), B, t0))
    assertEquals("still held", 1, held.books.size)
    assertEquals(listOf(bookA()), held.due(A, true, t0))
  }

  @Test
  fun removeLeavesAnotherAccountsRowForTheSameBook() {
    val held = HeldBooks(null)
    val same = BookMessage("srv-b", 2, bookA().ref, "One", null)
    held.hold(same, t0)
    held.hold(bookA(), t0)
    assertTrue(held.finishRemove(held.noteRemove(removeA()), A, t0))
    assertEquals(listOf(B), held.books.map { it.book.accountId })
  }

  @Test
  fun aBookSentAgainAfterARemoveSurvivesItsTurn() {
    val held = HeldBooks(null)
    held.hold(bookA(), t0)
    val ticket = held.noteRemove(removeA())
    // Held the moment it arrives, ahead of the remove's turn.
    held.hold(bookA(), t0.addingSeconds(1.0))
    assertTrue(held.finishRemove(ticket, A, t0.addingSeconds(1.0)))
    assertEquals(listOf(bookA()), held.due(A, true, t0.addingSeconds(1.0)))
  }

  @Test
  fun aBookFirstSentAfterARemoveSurvivesItsTurn() {
    val held = HeldBooks(null)
    val ticket = held.noteRemove(removeA())
    held.hold(bookA(), t0)
    assertTrue(held.finishRemove(ticket, A, t0))
    assertEquals(1, held.books.size)
  }

  @Test
  fun aRecordAboutToGoSettlesNoRow() {
    val held = HeldBooks(null)
    val ticket = held.noteRemove(removeA())
    held.hold(bookA(), t0)
    // The old record is still in the index: settled against it, the book sent again would be lost.
    held.settle(A, listOf(bookA().ref), t0)
    assertEquals(1, held.books.size)
    assertTrue(held.finishRemove(ticket, A, t0))
    held.settle(A, listOf(bookA().ref), t0)
    assertEquals("its turn over, the record speaks for it again", emptyList<HeldBook>(), held.books)
  }

  @Test
  fun stoppingThePlayingBookOnItsTurnSettlesNoRow() {
    val held = HeldBooks(null)
    val ticket = held.noteRemove(removeA())
    held.hold(bookA(), t0)
    var taken = false
    // Stopping it closes its span, which publishes with its record still in the index.
    assertTrue(
      held.finishRemove(ticket, A, t0) {
        taken = true
        held.settle(A, listOf(bookA().ref), t0)
      }
    )
    assertTrue(taken)
    assertEquals("the book sent again stands", 1, held.books.size)
  }

  @Test
  fun aRefusedRemoveTakesNoBook() {
    val held = HeldBooks(null)
    assertFalse(held.finishRemove(held.noteRemove(removeA()), B, t0) { fail("another account's book stays") })
  }

  // Home's On the way

  @Test
  fun homeListsWaitingRowsOnceEach() {
    val held = HeldBooks(null)
    held.hold(bookA("A/Beside"), t0)
    held.hold(bookA("A/Alone"), t0)
    held.hold(bookB("B/Other"), t0)
    held.hold(bookA("A/GivenUp"), t0.addingSeconds(-HeldBooks.MAX_AGE))
    held.settle(A, emptyList(), t0)
    val rows = HeldBooks.waiting(held.books, A, listOf(bookA("A/Beside").ref, bookB("B/Other").ref))
    assertEquals(
      "not one beside its record, not one given up on; a record is this account's alone",
      listOf("A/Alone", "B/Other"),
      rows.map { it.book.ref.path },
    )
  }

  @Test
  fun onlyWhatIsStillComingIsOnTheWay() {
    val coming = listOf(WatchStateBook.State.QUEUED, WatchStateBook.State.PREPARING, WatchStateBook.State.DOWNLOADING)
    assertTrue(coming.all { it.onTheWay })
    assertFalse(WatchStateBook.State.READY.onTheWay)
    assertFalse(WatchStateBook.State.FAILED.onTheWay)
  }

  // Wear's own: a held book keeps the phone's `sent_at` across a kill (the remove ordering reads it).
  @Test
  fun aHeldBookKeepsItsSentAt() {
    val file = tempFile()
    val sent = bookA().copy(sentAt = iso("2026-11-12T10:00:00.250Z"))
    HeldBooks(file).hold(sent, t0)
    assertEquals(sent.sentAt, HeldBooks(file).books[0].book.sentAt)
    assertNotNull(HeldBooks(file).due(A, true, t0)[0].sentAt)
  }
}

private fun state(signedIn: Boolean = true, unsent: Int = 0) =
  WatchState(
    signedIn = signedIn,
    serverId = if (signedIn) "srv" else null,
    userId = if (signedIn) 1 else null,
    appVersion = "2.6.0",
    books = emptyList(),
    unsentEvents = unsent,
    couldntSync = 0,
  )

class StatePublicationTest {
  @Test
  fun owesNothingBeforeTheFirstState() {
    assertNull(StatePublication().due)
  }

  @Test
  fun aStateTheDataLayerTookIsNotOwedAgain() {
    val p = StatePublication()
    p.update(state())
    p.tookIt(state())
    assertNull(p.due)
    p.update(state())
    assertNull(p.due)
  }

  @Test
  fun aRefusedSendStaysOwedForEveryNextMoment() {
    val p = StatePublication()
    p.update(state())
    // Refused: `tookIt` is never called.
    assertEquals(state(), p.due)
    p.tookIt(state())
    assertNull(p.due)
  }

  @Test
  fun aChangeIsOwedAndTheLatestWins() {
    val p = StatePublication()
    p.update(state(unsent = 1))
    p.tookIt(state(unsent = 1))
    p.update(state(unsent = 2))
    p.update(state(unsent = 3))
    assertEquals(state(unsent = 3), p.due)
  }

  @Test
  fun onlyAChangedStateIsNews() {
    val p = StatePublication()
    assertTrue(p.update(state(unsent = 1)))
    // Refused, so still owed, but the same state again is no reason to try.
    assertFalse(p.update(state(unsent = 1)))
    assertEquals(state(unsent = 1), p.due)
    assertTrue(p.update(state(unsent = 2)))
  }

  @Test
  fun aChangeBackAfterARefusalOwesNothing() {
    // The phone still holds what it last took, and that is the latest again.
    val p = StatePublication()
    p.update(state(unsent = 1))
    p.tookIt(state(unsent = 1))
    p.update(state(unsent = 2))
    p.update(state(unsent = 1))
    assertNull(p.due)
  }
}
