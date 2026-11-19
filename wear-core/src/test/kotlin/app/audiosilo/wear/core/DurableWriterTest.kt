// fe#285: the listening's durable files (outbox, open span, places) are written on one background
// thread, in the order asked across the files, so the main looper never waits on an fsync and a
// kill stops at a state the writes on the caller's thread would have passed through too.
package app.audiosilo.wear.core

import java.io.File
import java.util.concurrent.Executor
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DurableWriterTest {
  private lateinit var dir: File
  private lateinit var clock: TestClock
  private val synced = ArrayList<String>()
  private val threads = ArrayList<Thread>()
  private val ref = BookRef(2, "A/Folder")
  private val book = PlayingBook(ref, 3600.0)

  @Before
  fun setUp() {
    dir = tempDir()
    clock = TestClock()
    JsonFile.onSynced = {
      synchronized(synced) {
        synced += it.name
        threads += Thread.currentThread()
      }
    }
  }

  @After
  fun tearDown() {
    JsonFile.onSynced = null
    dir.deleteRecursively()
  }

  private fun at(pos: Double) = SpanEnd(pos, "A/Folder/1.mp3", pos)

  /** An executor that runs nothing until the test says so: the writes waiting in the queue. */
  private class Held : Executor {
    val queued = ArrayList<Runnable>()

    override fun execute(command: Runnable) {
      synchronized(queued) { queued += command }
    }

    /** Run the oldest waiting write; false with none left. */
    fun runOne(): Boolean {
      val next = synchronized(queued) { if (queued.isEmpty()) null else queued.removeAt(0) } ?: return false
      next.run()
      return true
    }
  }

  /** One launch's listening stores over `root`, writing through `writer` (null: on this thread). */
  private inner class Stores(root: File, writer: DurableWriter?) {
    private var ids = 0
    val outbox = Outbox(root, AckStore(null), DEVICE_ID, clock = { clock.now }, writer = writer)
    val places = PlaceStore(File(root, "places.json"), writer)
    val spans =
      SpanRecorder(
        FileSpanStore(File(root, "open-span.json"), File(root, "open-span-move.json"), writer),
        AckStore(null),
        clock = { clock.now },
        newId = {
          ids += 1
          "e$ids"
        },
        emit = { outbox.append(it) },
        keepPlace = { r, p -> places.set(r, p) },
      )

    /** A play, its keeps, a 15 s cut, a pause and a paused move, as the engine drives them. */
    fun listen() {
      spans.open(book, at(0.0), 1.0)
      for (pos in listOf(5.0, 10.0, 15.0, 20.0)) {
        clock.advance(5.0)
        val cut = spans.playingTick(book, at(pos), 1.0, keepDue = true, cutDue = pos == 15.0, reachable = true)
        places.set(ref, LocalPlace.of(at(pos), clock.now, 1.0), save = cut)
      }
      clock.advance(3.0)
      spans.close(at(23.0))
      clock.advance(10.0)
      spans.move(book, to = at(50.0), from = at(23.0), playing = false, speed = 1.0)
    }
  }

  /** The durable files in `root` as text, by name. */
  private fun disk(root: File): Map<String, String> =
    listOf("outbox.json", "open-span.json", "open-span-move.json", "places.json")
      .map { File(root, it) }
      .filter { it.isFile }
      .associate { it.name to it.readText() }

  @Test
  fun theWritesLeaveTheCallersThreadInTheOrderAsked() {
    val writer = DurableWriter()
    val s = Stores(dir, writer)
    s.spans.open(book, at(0.0), 1.0)
    clock.advance(12.0)
    s.spans.close(at(12.0))
    writer.drain()
    assertEquals(listOf("open-span.json", "outbox.json", "places.json", "open-span.json"), synced)
    assertTrue(threads.none { it === Thread.currentThread() })
    assertEquals(1, threads.toSet().size)
    assertEquals(12.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
    assertEquals(listOf("e1"), Outbox(dir, AckStore(null), DEVICE_ID).events.map { it.id })
    assertFalse(File(dir, "open-span.json").exists())
  }

  @Test
  fun theCallerGoesOnFromMemoryWhileTheWritesWait() {
    val held = Held()
    val s = Stores(dir, DurableWriter(held))
    s.spans.open(book, at(0.0), 1.0)
    clock.advance(12.0)
    s.spans.close(at(12.0))
    // Nothing on the disk yet; the stores answer from memory.
    assertEquals(emptyMap<String, String>(), disk(dir))
    assertEquals(listOf("e1"), s.outbox.events.map { it.id })
    assertEquals(12.0, s.places.place(ref)!!.position, 0.0)
    assertEquals(4, held.queued.size)
    while (held.runOne()) Unit
    assertEquals(listOf("open-span.json", "outbox.json", "places.json", "open-span.json"), synced)
  }

  // Every point a kill can stop the queue at is a state the writes on the caller's thread passed
  // through: the write order (an event before its span's removal, the place in between) holds.
  @Test
  fun everyPointOfTheQueueIsAStateTheInOrderWritesPassThrough() {
    val inline = File(dir, "inline").apply { mkdirs() }
    val queued = File(dir, "queued").apply { mkdirs() }
    val start = clock.now

    val expected = arrayListOf(disk(inline))
    JsonFile.onSynced = { expected += disk(inline) }
    Stores(inline, null).listen()

    clock.now = start
    JsonFile.onSynced = null
    val held = Held()
    val seen = arrayListOf(disk(queued))
    Stores(queued, DurableWriter(held)).listen()
    while (held.runOne()) seen += disk(queued)

    fun distinct(l: List<Map<String, String>>) = l.filterIndexed { i, m -> i == 0 || m != l[i - 1] }
    assertEquals(distinct(expected), distinct(seen))
    assertTrue("the scenario wrote something", distinct(seen).size > 5)
  }

  // The launch's join of an outbox set aside deletes it only once what it joined is written.
  @Test
  fun theLaunchJoinWaitsForItsWriteBeforeDeletingWhatItJoined() {
    val aside = File(dir, "outbox-unread-1.json")
    aside.writeText(JsonFile.FORMAT.encodeToString(kotlinx.serialization.builtins.ListSerializer(ListeningEvent.serializer()), listOf(listen("old"))))
    val slow = Executor { r ->
      Thread {
          Thread.sleep(100)
          r.run()
        }
        .start()
    }
    val outbox = Outbox(dir, AckStore(null), DEVICE_ID, writer = DurableWriter(slow))
    assertFalse(aside.exists())
    assertEquals(listOf("old"), Outbox(dir, AckStore(null), DEVICE_ID).events.map { it.id })
    assertEquals(listOf("old"), outbox.events.map { it.id })
  }

  // An offer's Jump acknowledges the row in memory within its move (the move's events go on the
  // row's version) and writes it after: a kill never leaves the acknowledgement on the disk without
  // the move (the watch would resume at its old place on the other device's version, sending that
  // place back).
  @Test
  fun aJumpsAcknowledgementIsWrittenAfterItsMove() {
    val held = Held()
    val writer = DurableWriter(held)
    val acks = AckStore(File(dir, "acks.json"), writer)
    val places = PlaceStore(File(dir, "places.json"), writer)
    val offered = row(lib = ref.libraryId, path = ref.path, version = 7, device = "other")
    acks.answerOffer(ref, offered, "other|t", save = false)
    assertEquals("the move's events go on the row's version", 7, acks.ackVersion(ref))
    assertEquals("nothing asked of the disk yet", 0, held.queued.size)
    places.set(ref, LocalPlace(offered.position, at = clock.now))
    acks.save()
    assertTrue(held.runOne())
    assertEquals("the move first", listOf("places.json"), dir.list()!!.toList())
    assertTrue(held.runOne())
    val read = AckStore(File(dir, "acks.json"))
    assertEquals(7, read.ackVersion(ref))
    assertEquals(listOf("other|t"), read.answered(ref))
  }

  // The acks and the sync state go on the same queue as the listening, in the order asked.
  @Test
  fun theAcksAndTheSyncStateGoInOrderWithTheListening() {
    val held = Held()
    val writer = DurableWriter(held)
    val acks = AckStore(File(dir, "acks.json"), writer)
    val places = PlaceStore(File(dir, "places.json"), writer)
    acks.ack(ref, 7)
    places.set(ref, LocalPlace(40.0, at = clock.now))
    assertEquals(emptyList<String>(), dir.list()!!.toList())
    assertTrue(held.runOne())
    assertEquals(listOf("acks.json"), dir.list()!!.toList())
    assertTrue(held.runOne())
    assertEquals(7, AckStore(File(dir, "acks.json")).ackVersion(ref))
    assertEquals(40.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
    // The sync state is queued behind the outbox write before it too.
    val outbox = Outbox(dir, AckStore(null), DEVICE_ID, writer = writer)
    outbox.discardFailed("none")
    assertFalse(File(dir, "sync-state.json").exists())
    while (held.runOne()) Unit
    assertTrue(File(dir, "sync-state.json").exists())
  }

  /** The retries a writer asked for, by their delay, run when the test says so. */
  private class Retries {
    val delays = ArrayList<Long>()
    private val waiting = ArrayList<Runnable>()

    fun after(ms: Long, r: Runnable) {
      delays += ms
      waiting += r
    }

    /** Run the oldest waiting retry; false with none. */
    fun fire(): Boolean {
      if (waiting.isEmpty()) return false
      waiting.removeAt(0).run()
      return true
    }
  }

  /** A disk that refuses every write while `full`, and keeps what lands, in order. */
  private class FakeDisk {
    var full = true
    val landed = ArrayList<String>()

    fun write(name: String): () -> Boolean = {
      if (full) false else true.also { landed += name }
    }
  }

  // A full disk (fe#285): the outbox write of a close fails. The place and the span's removal
  // asked after it wait for it rather than land without it (a kill then would lose the span: gone
  // from its file, its event in no outbox); it is tried again with a growing wait, and once the
  // disk has room it lands first and the rest follow in order.
  @Test
  fun aWriteThatFailsIsTriedAgainBeforeAnyAskedAfterIt() {
    val held = Held()
    val retries = Retries()
    val writer = DurableWriter(held, retries::after)
    // The outbox's folder is a file until the disk "has room": every write there fails.
    val full = File(dir, "outbox").apply { writeText("") }
    val outbox = Outbox(full, AckStore(null), DEVICE_ID, clock = { clock.now }, writer = writer)
    val places = PlaceStore(File(dir, "places.json"), writer)
    val spans =
      SpanRecorder(
        FileSpanStore(File(dir, "open-span.json"), File(dir, "open-span-move.json"), writer),
        AckStore(null),
        clock = { clock.now },
        newId = { "e1" },
        emit = { outbox.append(it) },
        keepPlace = { r, p -> places.set(r, p) },
      )
    spans.open(book, at(0.0), 1.0)
    assertTrue(held.runOne())
    clock.advance(12.0)
    spans.close(at(12.0))
    while (held.runOne()) Unit
    assertFalse("the place waits for the event", File(dir, "places.json").exists())
    assertTrue("the span stays recoverable", File(dir, "open-span.json").exists())
    assertEquals("one retry waits", listOf(500L), retries.delays)
    assertTrue(retries.fire())
    assertEquals(listOf(500L, 1000L), retries.delays)
    assertTrue(File(dir, "open-span.json").exists())
    full.delete()
    assertTrue(retries.fire())
    while (held.runOne()) Unit
    assertEquals(listOf("e1"), Outbox(full, AckStore(null), DEVICE_ID).events.map { it.id })
    assertEquals(12.0, PlaceStore(File(dir, "places.json")).place(ref)!!.position, 0.0)
    assertFalse(File(dir, "open-span.json").exists())
    assertFalse("nothing more to try", retries.fire())
  }

  // The tries are bounded: once a round is spent nothing runs (the writes behind still wait), until
  // the next write asked starts a new round.
  @Test
  fun aSpentRoundWaitsForTheNextWriteToTryAgain() {
    val held = Held()
    val retries = Retries()
    val writer = DurableWriter(held, retries::after)
    val disk = FakeDisk()
    writer.submit("open-span", disk.write("open-span"))
    writer.submit("places", disk.write("places"))
    while (held.runOne()) Unit
    while (retries.fire()) while (held.runOne()) Unit
    assertEquals(listOf(500L, 1000L, 2000L, 4000L, 8000L), retries.delays)
    assertEquals(DurableWriter.MAX_TRIES - 1, retries.delays.size)
    disk.full = false
    while (held.runOne()) Unit
    assertEquals("parked until asked", emptyList<String>(), disk.landed)
    writer.submit("outbox", disk.write("outbox"))
    while (held.runOne()) Unit
    assertEquals(listOf("open-span", "places", "outbox"), disk.landed)
  }

  // A `now` (the launch's join, the sign-out's drain) behind a write that still fails is told so
  // once the round is spent, its op not run; a later one, the disk back, goes through.
  @Test
  fun aNowBehindAWriteThatStillFailsIsToldItIsStuck() {
    val writer = DurableWriter(retryAfter = { _, r -> r.run() })
    val disk = FakeDisk()
    writer.submit("outbox", disk.write("outbox"))
    var ran = false
    assertThrows(DurableWriter.Stuck::class.java) { writer.now { ran = true } }
    assertFalse(ran)
    assertFalse(writer.drain())
    disk.full = false
    assertTrue(writer.drain())
    assertEquals(listOf("outbox"), disk.landed)
  }

  // Signing out: the removals that follow replace a write the disk still refuses, so it is dropped
  // rather than held in front of them (or landing after them).
  @Test
  fun signingOutDropsAFailedWriteALaterOneOfItsFileReplaces() {
    val held = Held()
    val retries = Retries()
    val writer = DurableWriter(held, retries::after)
    val disk = FakeDisk()
    writer.submit("outbox", disk.write("outbox"))
    assertTrue(held.runOne())
    assertEquals(1, retries.delays.size)
    val removals = FakeDisk().apply { full = false }
    writer.submit("places", removals.write("places removed"))
    writer.submit("outbox", removals.write("outbox removed"))
    writer.dropSuperseded()
    while (held.runOne()) Unit
    assertEquals(listOf("places removed", "outbox removed"), removals.landed)
    disk.full = false
    retries.fire()
    while (held.runOne()) Unit
    assertEquals("never lands after its removal", emptyList<String>(), disk.landed)
  }
}
