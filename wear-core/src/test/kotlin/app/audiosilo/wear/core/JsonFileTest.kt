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
import org.junit.Assert.assertTrue
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
    // discardAll writes the status too: it lands, unsynced.
    synced.clear()
    outbox.discardAll()
    assertTrue(File(dir, "sync-state.json").isFile)
    assertEquals(listOf("outbox.json"), synced)
    assertEquals(emptyList<String>(), leftovers())
  }

  @Test
  fun theOpenSpanIsSynced() {
    val store = FileSpanStore(File(dir, "open-span.json"))
    val end = SpanEnd(10.0, "A/Folder/1.mp3", 10.0)
    val span =
      OpenSpan(2, "A/Folder", end, end, 100.0, 1.0, iso("2026-10-25T07:00:00.000Z"),
        iso("2026-10-25T07:00:05.000Z"), ListeningStart.RESUME, null, "span-1")
    store.save(span)
    assertEquals(listOf("open-span.json"), synced)
    assertEquals(span, store.load())
  }

  @Test
  fun thePlacesAreSyncedAndTheAcksAreNot() {
    val ref = BookRef(2, "A/Folder")
    PlaceStore(File(dir, "places.json")).set(ref, LocalPlace(42.0, at = iso("2026-10-25T07:00:00.000Z")))
    AckStore(File(dir, "acks.json")).ack(ref, 7)
    assertEquals(listOf("places.json"), synced)
    assertEquals(42.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
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

  /** One launch's stores over the files in `dir`. */
  private inner class Launch {
    val outbox = Outbox(dir, AckStore(null), DEVICE_ID, clock = { clock.now })
    val places = PlaceStore(File(dir, "places.json"))
    val spans =
      SpanRecorder(
        FileSpanStore(File(dir, "open-span.json")),
        AckStore(null),
        clock = { clock.now },
        newId = {
          ids += 1
          "e$ids"
        },
        emit = { outbox.append(it) },
      )

    /** What the engine's tick stores, as PlayerEngine.tick does it. */
    fun tick(pos: Double, keepDue: Boolean, cutDue: Boolean, reachable: Boolean = true) {
      val cut = spans.playingTick(book, at(pos), 1.0, keepDue, cutDue, reachable)
      places.set(ref, LocalPlace.of(at(pos), clock.now, 1.0), save = cut)
    }
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
    assertEquals(5.0, FileSpanStore(File(dir, "open-span.json")).load()!!.to.pos, 0.0)
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
    val stored = FileSpanStore(File(dir, "open-span.json")).load()!!
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
    next.spans.recover()?.let(next.places::recover)
    val place = next.places.place(ref)!!
    assertEquals(25.0, place.position, 0.0)
    assertEquals("A/Folder/1.mp3", place.file)
    assertEquals(25.0, place.filePos!!, 0.0)
    assertEquals("the time it was heard, not the launch's", keptAt, place.at)
    assertEquals(25.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
    assertEquals(listOf("e1", "e2"), next.outbox.events.map { it.id })
  }

  @Test
  fun aSpanNeverKeptOrOlderThanTheSavedPlaceLeavesThePlace() {
    val saved = LocalPlace(40.0, at = clock.now)
    val places = PlaceStore(File(dir, "places.json"))
    places.set(ref, saved)
    // Killed right after the play opened it: the loaded place, stamped with the play's time.
    places.recover(OpenSpan(2, "A/Folder", at(10.0), at(10.0), 3600.0, 1.0, clock.now.addingSeconds(5.0),
      clock.now.addingSeconds(5.0), ListeningStart.RESUME, 0, "a"))
    assertEquals(saved, places.place(ref))
    // Kept, but before the saved place (a seek saved after it).
    places.recover(OpenSpan(2, "A/Folder", at(10.0), at(20.0), 3600.0, 1.0, clock.now.addingSeconds(-20.0),
      clock.now.addingSeconds(-10.0), ListeningStart.RESUME, 0, "b"))
    assertEquals(saved, places.place(ref))
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
    next.spans.recover()?.let(next.places::recover)
    val place = next.places.place(ref)!!
    assertEquals(15.0, place.position, 0.0)
    assertEquals(cutAt, place.at)
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
