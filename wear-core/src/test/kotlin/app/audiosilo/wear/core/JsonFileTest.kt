// JsonFile's write path: whole, atomic, and synced to the disk for the files that hold listening
// (the outbox, the open span, the places), so a battery death never leaves one empty.
package app.audiosilo.wear.core

import java.io.File
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Before
import org.junit.Test

class JsonFileTest {
  private lateinit var dir: File
  private val synced = ArrayList<String>()

  @Before
  fun setUp() {
    dir = tempDir()
    JsonFile.onSynced = { synchronized(synced) { synced += it.name } }
  }

  @After
  fun tearDown() {
    JsonFile.onSynced = null
    dir.deleteRecursively()
  }

  private fun leftovers(): List<String> = dir.listFiles()!!.map { it.name }.filter { it.endsWith(".tmp") }

  @Test
  fun aDurableWriteLandsWholeLeavesNoTempAndIsSynced() {
    val file = JsonFile(File(dir, "doc.json"), ListSerializer(String.serializer()), durable = true)
    assertTrue(file.write(listOf("one", "two")))
    assertTrue(file.write(listOf("three")))
    assertEquals(listOf("three"), file.read())
    assertEquals(emptyList<String>(), leftovers())
    assertEquals(listOf("doc.json", "doc.json"), synced)
  }

  @Test
  fun aPlainWriteLandsTheSameWithoutASync() {
    val file = JsonFile(File(dir, "cache.json"), ListSerializer(String.serializer()))
    assertTrue(file.write(listOf("one")))
    assertEquals(listOf("one"), file.read())
    assertEquals(emptyList<String>(), leftovers())
    assertEquals(emptyList<String>(), synced)
  }

  @Test
  fun aWriteIntoAFolderThatCannotBeMadeLeavesNothingBehind() {
    // A file where its folder should be: nothing lands, nothing is synced, the old file stays.
    val blocker = File(dir, "blocker").apply { writeText("x") }
    val file = JsonFile(File(blocker, "doc.json"), ListSerializer(String.serializer()), durable = true)
    assertFalse(file.write(listOf("one")))
    assertEquals("x", blocker.readText())
    assertEquals(emptyList<String>(), synced)
  }

  @Test
  fun aFailedMoveRemovesItsTempAndKeepsTheOldFile() {
    // A folder where the file should be: the move fails after the bytes are written.
    File(dir, "doc.json").mkdirs()
    File(dir, "doc.json/inside").writeText("x")
    val file = JsonFile(File(dir, "doc.json"), ListSerializer(String.serializer()), durable = true)
    assertFalse(file.write(listOf("one")))
    assertEquals(emptyList<String>(), leftovers())
    assertTrue(File(dir, "doc.json/inside").isFile)
  }

  @Test
  fun theOutboxSyncsItsEventsButNotItsStatus() {
    val outbox = Outbox(dir, AckStore(File(dir, "acks.json")), DEVICE_ID)
    outbox.append(listOf(listen("e1")))
    assertTrue("outbox.json" in synced)
    assertFalse("sync-state.json" in synced)
    assertEquals(listOf("e1"), Outbox(dir, AckStore(null), DEVICE_ID).events.map { it.id })
    outbox.apply(SyncResponse(results = listOf(SyncResult("e1", "applied"))), outbox.events, null, null)
    assertTrue(File(dir, "sync-state.json").isFile)
    assertFalse("sync-state.json" in synced)
    outbox.append(listOf(listen("e2")))
    synced.clear()
    outbox.discardAll()
    assertFalse(File(dir, "sync-state.json").exists())
    assertEquals(listOf("outbox.json"), synced)
    assertEquals(emptyList<String>(), leftovers())
  }

  @Test
  fun theOpenSpanIsSynced() {
    val store = fileSpanStore(dir)
    val end = SpanEnd(10.0, "A/Folder/1.mp3", 10.0)
    val span =
      OpenSpan(2, "A/Folder", end, end, 100.0, 1.0, iso("2026-10-25T07:00:00.000Z"),
        iso("2026-10-25T07:00:05.000Z"), ListeningStart.RESUME, null, "span-1")
    store.save(span)
    assertEquals(listOf("open-span.json"), synced)
    assertEquals(span, store.load())
    synced.clear()
    val move = RecoveredMove(BookRef(2, "A/Folder"), ListeningStart.MOVED_BACK)
    store.saveMove(move)
    assertEquals(listOf("open-span-move.json"), synced)
    assertEquals(move, store.loadMove())
  }

  @Test
  fun thePlacesAreSyncedAndTheAcksAreNot() {
    val ref = BookRef(2, "A/Folder")
    PlaceStore(File(dir, "places.json")).set(ref, LocalPlace(42.0, at = iso("2026-10-25T07:00:00.000Z")))
    AckStore(File(dir, "acks.json")).ack(ref, 7)
    assertEquals(listOf("places.json"), synced)
    assertEquals(42.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
  }

  // The vectors of watch-core's JSONFileTests (fe#219): each case told apart.
  @Test
  fun loadTellsMissingValueUnreadableAndCorruptApart() {
    val file = JsonFile(File(dir, "doc.json"), ListSerializer(String.serializer()))
    assertEquals(JsonLoad.Missing, file.load())
    assertTrue(file.write(listOf("one")))
    assertEquals(JsonLoad.Value(listOf("one")), file.load())
    file.file.setReadable(false)
    if (!file.file.canRead()) {
      // Where permissions hold (not as root).
      assertEquals(JsonLoad.Unreadable, file.load())
      assertNull(file.read())
    }
    file.file.setReadable(true)
    file.file.writeText("not json")
    assertEquals(JsonLoad.Corrupt, file.load())
    assertNull(file.read())
  }

  @Test
  fun moveAsideKeepsTheFileBesideIt() {
    val file = JsonFile(File(dir, "downloads.json"), ListSerializer(String.serializer()))
    file.file.writeText("damaged")
    assertTrue(file.moveAside("downloads-unread-"))
    assertEquals(JsonLoad.Missing, file.load())
    val aside = dir.listFiles()!!.single { it.name.startsWith("downloads-unread-") && it.name.endsWith(".json") }
    assertEquals("damaged", aside.readText())
    assertFalse(file.moveAside("downloads-unread-"))
  }

  // An index that does not decode was read as no books, and the next save wrote over it.
  @Test
  fun aDownloadIndexThatDoesNotDecodeIsSetAsideNeverWrittenOver() {
    val main = File(dir, "downloads.json").apply { writeText("not this build's format") }
    val index = DownloadIndex(main) { "folder-1" }
    assertEquals(emptyList<DownloadRecord>(), index.records.value)
    index.enqueue(BookRef(1, "A/Book"), "Book", null, iso("2026-11-16T10:00:00Z"))
    val aside = dir.listFiles()!!.single { it.name.startsWith("downloads-unread-") }
    assertEquals("not this build's format", aside.readText())
    assertEquals(listOf("A/Book"), DownloadIndex(main).records.value.map { it.ref.path })
  }

  // One that can't be moved aside either stays in the way: nothing is written over it, the books
  // are in memory alone (`saved` false), and it is moved once it can be.
  @Test
  fun aDownloadIndexThatCantBeMovedAsideIsNeverWrittenOver() {
    val main = File(dir, "downloads.json").apply { writeText("not this build's format") }
    dir.setWritable(false)
    try {
      // Where permissions hold (not as root).
      assumeFalse(dir.canWrite())
      val index = DownloadIndex(main) { "folder-1" }
      index.enqueue(BookRef(1, "A/Book"), "Book", null, iso("2026-11-16T10:00:00Z"))
      assertFalse(index.saved)
      assertEquals("not this build's format", main.readText())
      dir.setWritable(true)
      index.update(BookRef(1, "A/Book")) { it.copy(title = "Book again") }
      assertTrue(index.saved)
      val aside = dir.listFiles()!!.single { it.name.startsWith("downloads-unread-") }
      assertEquals("not this build's format", aside.readText())
      assertEquals(listOf("Book again"), DownloadIndex(main).records.value.map { it.title })
    } finally {
      dir.setWritable(true)
    }
  }
}

/**
 * How often the playing engine syncs (PlayerEngine.tick, driven here through the same core calls):
 * once per plain 5 s tick (the open span; the place stays in memory), three times on the 15 s cut
 * (the outbox, then the next span over the closed one, then the place).
 */
class DurableRateTest {
  private lateinit var dir: File
  private lateinit var clock: TestClock
  private val synced = ArrayList<String>()
  private val ref = BookRef(2, "A/Folder")
  private val book = PlayingBook(ref, 3600.0)
  private var ids = 0

  @Before
  fun setUp() {
    dir = tempDir()
    clock = TestClock()
    ids = 0
    JsonFile.onSynced = { synchronized(synced) { synced += it.name } }
  }

  @After
  fun tearDown() {
    JsonFile.onSynced = null
    dir.deleteRecursively()
  }

  private fun at(pos: Double) = SpanEnd(pos, "A/Folder/1.mp3", pos)

  /** A kill: what the process was writing stops here. */
  private class Kill : RuntimeException("killed")

  /** One launch's stores over the files in `dir`. */
  private inner class Launch {
    val outbox = Outbox(dir, AckStore(null), DEVICE_ID, clock = { clock.now })
    val places = PlaceStore(File(dir, "places.json"))

    /** Set: the process is killed right after the outbox keeps the next events. */
    var killAfterAppend = false

    /** Set: the process is killed as the recorder keeps a place, before it is written. */
    var killAtPlace = false
    val spans =
      SpanRecorder(
        fileSpanStore(dir),
        AckStore(null),
        clock = { clock.now },
        newId = {
          ids += 1
          "e$ids"
        },
        emit = {
          outbox.append(it)
          if (killAfterAppend) throw Kill()
        },
        keepPlace = { r, p ->
          if (killAtPlace) throw Kill()
          places.set(r, p)
        },
      )

    /**
     * What the engine's tick stores, as PlayerEngine.tick does it (`heardAt`: its `lastAdvance`):
     * the place stamped now, and only while the audio plays (`buffering`: no place at all).
     */
    fun tick(
      pos: Double,
      keepDue: Boolean,
      cutDue: Boolean,
      reachable: Boolean = true,
      heardAt: java.time.Instant? = null,
      buffering: Boolean = false,
    ) {
      val cut = spans.playingTick(book, at(pos), 1.0, keepDue, cutDue, reachable, heardAt)
      if (!buffering) places.set(ref, LocalPlace.of(at(pos), clock.now, 1.0), save = cut)
    }

    /** The launch's recovery, as AppModel runs it. */
    fun recover() = outbox.recoverListening("a", places, spans)
  }

  private fun syncedBy(block: () -> Unit): List<String> {
    synced.clear()
    block()
    return synced.toList()
  }

  @Test
  fun aPlainTickSyncsTheOpenSpanOnly() {
    val l = Launch()
    l.spans.open(book, at(0.0), 1.0)
    clock.advance(5.0)
    assertEquals(listOf("open-span.json"), syncedBy { l.tick(5.0, keepDue = true, cutDue = false) })
    assertEquals(5.0, fileSpanStore(dir).load()!!.to.pos, 0.0)
    // The place moved in memory, not on the disk.
    assertEquals(5.0, l.places.place(ref)!!.position, 0.0)
    assertNull(PlaceStore(File(dir, "places.json")).place(ref))
  }

  @Test
  fun aCutTickWritesTheOpenSpanOnceAfterTheOutbox() {
    val l = Launch()
    l.spans.open(book, at(0.0), 1.0)
    clock.advance(15.0)
    // No keep and no removal of the closed span: the next span replaces it, after the event is kept.
    assertEquals(
      listOf("outbox.json", "open-span.json", "places.json"),
      syncedBy { l.tick(15.0, keepDue = true, cutDue = true) },
    )
    assertEquals(listOf("e1"), l.outbox.events.map { it.id })
    val stored = fileSpanStore(dir).load()!!
    assertEquals("e2", stored.id)
    assertEquals(ListeningStart.CONTINUE, stored.start)
    assertEquals(15.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
  }

  @Test
  fun offlineTheCutTickIsAPlainKeep() {
    val l = Launch()
    l.spans.open(book, at(0.0), 1.0)
    clock.advance(15.0)
    assertEquals(
      listOf("open-span.json"),
      syncedBy { l.tick(15.0, keepDue = true, cutDue = true, reachable = false) },
    )
    assertEquals(emptyList<ListeningEvent>(), l.outbox.events)
  }

  @Test
  fun aKillBetweenSavesResumesWhereTheOpenSpanWasKept() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(15.0)
    first.tick(15.0, keepDue = true, cutDue = true) // saved: 15
    clock.advance(5.0)
    first.tick(20.0, keepDue = true, cutDue = false)
    clock.advance(5.0)
    first.tick(25.0, keepDue = true, cutDue = false)
    val keptAt = clock.now
    // A kill: nothing more is written. The next launch reads the saved place (15) and the open span.
    clock.advance(30.0)
    val next = Launch()
    assertEquals(15.0, next.places.place(ref)!!.position, 0.0)
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(25.0, place.position, 0.0)
    assertEquals("A/Folder/1.mp3", place.file)
    assertEquals(25.0, place.filePos!!, 0.0)
    assertEquals("the time it was heard, not the launch's", keptAt, place.at)
    assertEquals(25.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
    assertEquals(listOf("e1", "e2"), next.outbox.events.map { it.id })
  }

  @Test
  fun aSpanThatNeverMovedLeavesThePlace() {
    val saved = LocalPlace(40.0, at = clock.now)
    val places = PlaceStore(File(dir, "places.json"))
    places.set(ref, saved)
    // Killed right after the play opened it: the loaded place, stamped with the play's time.
    places.recover(OpenSpan(2, "A/Folder", at(10.0), at(10.0), 3600.0, 1.0, clock.now.addingSeconds(5.0),
      clock.now.addingSeconds(5.0), ListeningStart.RESUME, 0, "a"))
    assertEquals(saved, places.place(ref))
    // Kept while it buffered from the start: still the loaded place, still not heard.
    places.recover(OpenSpan(2, "A/Folder", at(10.0), at(10.0), 3600.0, 1.0, clock.now.addingSeconds(5.0),
      clock.now.addingSeconds(15.0), ListeningStart.RESUME, 0, "b"))
    assertEquals(saved, places.place(ref))
    // The player settled a hair off the place it was given: no second of it heard.
    places.recover(OpenSpan(2, "A/Folder", at(10.0), at(10.3), 3600.0, 1.0, clock.now.addingSeconds(5.0),
      clock.now.addingSeconds(15.0), ListeningStart.RESUME, 0, "d"))
    assertEquals(saved, places.place(ref))
  }

  // fe#285: the place is saved only as a span opens, so the span a kill left is the newer by the
  // order of the writes; a wall clock set back since must not hide it.
  @Test
  fun aWallClockSetBackDoesNotHideTheNewerSpan() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(15.0)
    first.tick(15.0, keepDue = true, cutDue = true) // saved: 15, stamped now
    clock.advance(-3600.0)
    clock.advance(5.0)
    first.tick(20.0, keepDue = true, cutDue = false)
    val keptAt = clock.now
    // A kill.
    val next = Launch()
    assertEquals(15.0, next.places.place(ref)!!.position, 0.0)
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(20.0, place.position, 0.0)
    assertEquals(keptAt, place.at)
  }

  // A play after a pause opened after the pause's event was queued, so a wall clock set back
  // between the two must not hide it either (its `from` is the loaded place, not a cut's).
  @Test
  fun aWallClockSetBackDoesNotHideAPlayAfterAPause() {
    val first = Launch()
    first.recover()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(12.0)
    first.spans.close(at(12.0))
    clock.advance(-3600.0)
    first.spans.open(book, at(12.0), 1.0)
    clock.advance(5.0)
    first.tick(17.0, keepDue = true, cutDue = false)
    val keptAt = clock.now
    // A kill.
    val next = Launch()
    assertEquals(12.0, next.places.place(ref)!!.position, 0.0)
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(17.0, place.position, 0.0)
    assertEquals(keptAt, place.at)
  }

  // fe#285: a kill between the cut's append and the next span's write leaves the closed span in
  // its file at its last keep; its own event, already in the outbox, says where it ended.
  @Test
  fun aKillBetweenTheCutsEventAndItsNextSpanResumesAtTheCut() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(5.0)
    first.tick(5.0, keepDue = true, cutDue = false)
    clock.advance(5.0)
    first.tick(10.0, keepDue = true, cutDue = false)
    clock.advance(5.0)
    val cutAt = clock.now
    first.killAfterAppend = true
    assertThrows(Kill::class.java) { first.tick(15.0, keepDue = true, cutDue = true) }
    assertEquals("the span file still holds the last keep", 10.0, fileSpanStore(dir).load()!!.to.pos, 0.0)
    clock.advance(30.0)
    val next = Launch()
    assertEquals(listOf("e1"), next.outbox.events.map { it.id })
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(15.0, place.position, 0.0)
    assertEquals(cutAt, place.at)
    assertEquals(15.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
    assertEquals("the event goes once", listOf("e1"), next.outbox.events.map { it.id })
    assertNull(fileSpanStore(dir).load())
  }

  // fe#285: a cut right behind a bare move opens the next span with the move's reason, not
  // `continue`; it opened where the closed span ended, so a kill before its place write takes it.
  @Test
  fun aKillAfterACutBehindABareMoveResumesAtTheCut() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(14.8)
    first.spans.move(book, to = at(100.0), from = at(14.8), playing = true, speed = 1.0)
    clock.advance(0.2)
    // The cut, with nothing heard since the move: the next span is a `jump`. Killed before the place.
    first.spans.playingTick(book, at(100.2), 1.0, keepDue = true, cutDue = true, reachable = true)
    val cutAt = clock.now
    val left = fileSpanStore(dir).load()!!
    assertEquals(ListeningStart.JUMP, left.start)
    assertTrue(left.fromHeard)
    clock.advance(30.0)
    val next = Launch()
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(100.2, place.position, 0.0)
    assertEquals(cutAt, place.at)
  }

  // fe#285: buffering, the audio stands still while the 5 s keeps go on: the span ends when the
  // audio last moved, so the place a kill recovers is stamped when it was heard, not later.
  @Test
  fun aKillWhileBufferingStampsThePlaceWhenItWasHeard() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(5.0)
    val heard = clock.now
    first.tick(5.0, keepDue = true, cutDue = false, heardAt = heard)
    // Buffering: no movement for 8 s, the keeps still run.
    clock.advance(5.0)
    first.tick(5.0, keepDue = true, cutDue = false, heardAt = heard, buffering = true)
    assertEquals(heard, fileSpanStore(dir).load()!!.endedAt)
    clock.advance(3.0)
    first.tick(5.0, keepDue = true, cutDue = false, heardAt = heard, buffering = true)
    clock.advance(30.0)
    val next = Launch()
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(5.0, place.position, 0.0)
    assertEquals(heard, place.at)
  }

  // fe#285: a cut while buffering (the audio still for `Spans.STALL`) is no cut: the span closes
  // where and when the audio last moved, its place kept then, and no span follows to stand still.
  @Test
  fun aCutWhileBufferingKeepsThePlaceWhenItWasHeard() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(10.0)
    val heard = clock.now
    first.tick(10.0, keepDue = true, cutDue = false, heardAt = heard)
    clock.advance(5.0)
    first.tick(10.0, keepDue = false, cutDue = true, heardAt = heard, buffering = true)
    assertNull(fileSpanStore(dir).load())
    assertEquals(heard, ISOTime.parse((first.outbox.events.single() as SpanEvent).endedAt))
    clock.advance(2.0)
    val next = Launch()
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(10.0, place.position, 0.0)
    assertEquals(heard, place.at)
  }

  // fe#285: the place goes into places.json before the span leaves its file, so a kill during the
  // launch's own recovery finds the span again.
  @Test
  fun theRecoveredPlaceIsSavedBeforeTheSpanLeavesItsFile() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(5.0)
    first.tick(5.0, keepDue = true, cutDue = false)
    val next = Launch()
    assertEquals(listOf("places.json", "outbox.json", "open-span.json"), syncedBy { next.recover() })
  }

  // The book's end keeps its last span and its `finish` in one append: a kill right after it finds
  // both in the outbox. The finish keeps the span left on disk from restoring its place.
  @Test
  fun aKillInsideTheBooksLastCloseKeepsItsFinish() {
    val first = Launch()
    first.spans.open(book, at(3580.0), 1.0)
    clock.advance(15.0)
    first.tick(3595.0, keepDue = true, cutDue = false)
    clock.advance(5.0)
    first.killAfterAppend = true
    assertThrows(Kill::class.java) { first.spans.finish(book, at(3600.0)) }
    assertEquals("the span file still holds the last keep", 3595.0, fileSpanStore(dir).load()!!.to.pos, 0.0)
    val next = Launch()
    next.recover()
    assertNull(next.places.place(ref))
    assertEquals(listOf("e1"), next.outbox.events.filterIsInstance<SpanEvent>().map { it.id })
    assertEquals(listOf("finish"), next.outbox.events.filterIsInstance<FinishEvent>().map { it.kind })
  }

  // fe#321: the move a kill cut short outlives a launch that never plays (a background one).
  @Test
  fun aKilledMoveOutlivesALaunchThatNeverPlays() {
    val first = Launch()
    first.spans.open(book, at(80.0), 1.0)
    clock.advance(10.0)
    first.spans.move(book, to = at(10.0), from = at(90.0), playing = true, speed = 1.0)
    // A kill; a background launch recovers the span and ends without a play.
    Launch().recover()
    assertNull(fileSpanStore(dir).load())
    assertEquals(RecoveredMove(BookRef(2, "A/Folder"), ListeningStart.MOVED_BACK), fileSpanStore(dir).loadMove())
    // The next launch plays the book from this watch's own place: its first span is the move's.
    val third = Launch()
    third.recover()
    third.spans.prepareStart(ListeningStart.RESUME)
    third.spans.open(book, at(10.0), 1.0)
    assertEquals(ListeningStart.MOVED_BACK, third.spans.span?.start)
    assertNull("taken once", fileSpanStore(dir).loadMove())
  }

  @Test
  fun aKillBetweenTheCutsSpanAndItsPlaceResumesAtTheCut() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(15.0)
    // The cut's outbox and next span are written; the kill comes before the place is.
    first.spans.playingTick(book, at(15.0), 1.0, keepDue = true, cutDue = true, reachable = true)
    val cutAt = clock.now
    clock.advance(30.0)
    val next = Launch()
    assertNull(next.places.place(ref))
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(15.0, place.position, 0.0)
    assertEquals(cutAt, place.at)
  }

  // fe#285: a pause keeps the place after the span's event and before the span leaves its file,
  // so no kill finds neither (the span was removed and the place not yet written).
  @Test
  fun aPauseKeepsThePlaceBetweenItsEventAndTheSpansRemoval() {
    val l = Launch()
    l.spans.open(book, at(0.0), 1.0)
    clock.advance(5.0)
    l.tick(5.0, keepDue = true, cutDue = false)
    clock.advance(7.0)
    assertEquals(listOf("outbox.json", "places.json", "open-span.json"), syncedBy { l.spans.close(at(12.0)) })
    val place = PlaceStore(File(dir, "places.json")).place(ref)!!
    assertEquals(12.0, place.position, 0.0)
    assertEquals(clock.now, place.at)
  }

  // fe#285: killed at the pause's place write, the span is still in its file and its event in the
  // outbox: the next launch resumes where the pause was, not at the last saved place.
  @Test
  fun aKillAtThePausesPlaceResumesWhereItPaused() {
    val first = Launch()
    first.spans.open(book, at(0.0), 1.0)
    clock.advance(15.0)
    first.tick(15.0, keepDue = true, cutDue = true) // saved: 15
    clock.advance(5.0)
    first.tick(20.0, keepDue = true, cutDue = false)
    clock.advance(3.0)
    val pausedAt = clock.now
    first.killAtPlace = true
    assertThrows(Kill::class.java) { first.spans.close(at(23.0)) }
    clock.advance(30.0)
    val next = Launch()
    assertEquals(15.0, next.places.place(ref)!!.position, 0.0)
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(23.0, place.position, 0.0)
    assertEquals(pausedAt, place.at)
  }

  // fe#285: a move while playing keeps its target after the next span replaces the closed one; a
  // kill before that place write recovers the target from the span (its `from` is a place).
  @Test
  fun aKillAtAPlayingMovesPlaceResumesAtItsTarget() {
    val first = Launch()
    first.spans.open(book, at(80.0), 1.0)
    clock.advance(10.0)
    val movedAt = clock.now
    first.killAtPlace = true
    assertThrows(Kill::class.java) {
      first.spans.move(book, to = at(10.0), from = at(90.0), playing = true, speed = 1.0)
    }
    assertEquals(10.0, fileSpanStore(dir).load()!!.from.pos, 0.0)
    val next = Launch()
    next.recover()
    val place = next.places.place(ref)!!
    assertEquals(10.0, place.position, 0.0)
    assertEquals(movedAt, place.at)
    // Written in that order otherwise: the event, the next span over the closed one, the place.
    val again = Launch()
    again.spans.open(book, at(10.0), 1.0)
    clock.advance(10.0)
    assertEquals(
      listOf("outbox.json", "open-span.json", "places.json"),
      syncedBy { again.spans.move(book, to = at(50.0), from = at(20.0), playing = true, speed = 1.0) },
    )
  }

  // fe#285: a move while paused keeps its target before its event goes into the outbox: a kill
  // between the two leaves the watch at the target, never behind a move the server is sent.
  @Test
  fun aPausedMoveKeepsItsPlaceBeforeItsEvent() {
    val l = Launch()
    assertEquals(
      listOf("places.json", "outbox.json"),
      syncedBy { l.spans.move(book, to = at(40.0), from = at(10.0), playing = false, speed = 1.0) },
    )
    assertEquals(40.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
  }

  private fun answered(outbox: Outbox, id: String) {
    val sent = listOf(listen(id))
    outbox.apply(answer(SyncRequest(DEVICE_ID, events = sent)), sent, null, null)
  }

  @Test
  fun anEmptyOutboxRemovesItsFileAndAMissingFileIsEmpty() {
    assertEquals(emptyList<ListeningEvent>(), Outbox(dir, AckStore(null), DEVICE_ID).events)
    val outbox = Outbox(dir, AckStore(null), DEVICE_ID)
    outbox.append(listOf(listen("e1"), listen("e2")))
    val file = File(dir, "outbox.json")
    assertTrue(file.isFile)
    // One answered: the rest is written. Both answered: the file goes, its removal synced.
    assertEquals(listOf("outbox.json"), syncedBy { answered(outbox, "e1") })
    assertTrue(file.isFile)
    assertEquals(listOf("outbox.json"), syncedBy { answered(outbox, "e2") })
    assertFalse(file.exists())
    assertEquals(emptyList<ListeningEvent>(), Outbox(dir, AckStore(null), DEVICE_ID).events)
    assertEquals(emptyList<String>(), dir.listFiles()!!.map { it.name }.filter { it.startsWith("outbox") })
  }

  @Test
  fun anEmptyFileSetAsideIsJoinedAndGone() {
    // A file set aside that reads as no events: joined (nothing to add), then removed, no `[]` written.
    val aside = File(dir, "outbox-unread-1.json").apply { writeText("[]") }
    assertEquals(emptyList<ListeningEvent>(), Outbox(dir, AckStore(null), DEVICE_ID).events)
    assertFalse(aside.exists())
    assertFalse(File(dir, "outbox.json").exists())
  }
}
