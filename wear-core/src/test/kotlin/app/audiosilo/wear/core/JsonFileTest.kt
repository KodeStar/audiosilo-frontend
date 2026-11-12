// JsonFile's write path: whole, atomic, and synced to the disk for the files that hold listening
// (the outbox, the open span, the places), so a battery death never leaves one empty.
package app.audiosilo.wear.core

import java.io.File
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
