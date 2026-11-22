// Ported from watch-core/Tests/WatchCoreTests/OutboxTests.swift (itself listening-outbox.test.ts:
// flushOutbox, giving up, the server clock, keptMine; and place-reconcile.test.ts: offerOf,
// OFFER_REPEAT_MS). Not ported: the Apple Watch's background upload body (`backgroundBody`,
// `applyBackground`, `clock_offset`): a Wear body is built as it is sent (W4 decision 9).
package app.audiosilo.wear.core

import java.io.File
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeFalse
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OutboxTest {
  private lateinit var clock: TestClock
  private lateinit var acks: AckStore

  @Before
  fun setUp() {
    clock = TestClock("2026-10-25T08:00:00.000Z")
    acks = AckStore(null)
  }

  private fun outbox(dir: File? = null) = Outbox(dir, acks, DEVICE_ID) { clock.now }

  private val ref = BookRef(3, "Author/Book")

  private fun failures(o: Outbox) = o.couldNotSync().map { listOf(it.event.id, it.reason) }

  private fun restore(
    box: Outbox,
    account: String = "a",
    places: PlaceStore = PlaceStore(null),
    store: MemorySpanStore = MemorySpanStore(),
  ): PlaceStore {
    box.recoverListening(account, places, SpanRecorder(store, acks, emit = box::append))
    return places
  }

  @get:Rule val folder = TemporaryFolder()

  private val sentFile get() = File(folder.root, "no_backup/sent-places.json")

  private fun launch(writer: DurableWriter? = null) =
    Outbox(folder.root, acks, DEVICE_ID, writer, sentFile) { clock.now }

  private fun sentBooks() = JsonFile(sentFile, SentPlaces.serializer()).read()!!.books

  @Test
  fun removingABookForgetsOnlyItsPlaceUntilItsListeningIsAnswered() = runBlocking {
    val old = listen("old")
    val other = listen("keep", path = "Another book")
    val first = launch()
    restore(first)
    first.append(listOf(old, other))
    first.forgetPlace(ref)

    val next = launch()
    val places = restore(next)
    assertNull(places.place(ref))
    assertEquals(16800.0, places.place(other.ref)!!.position, 0.0)
    val server = FakeTransport()
    next.flush(server)
    assertEquals(listOf(old, other), server.bodies.single().events)
    assertEquals(setOf(other.ref.key), sentBooks().keys)
    next.discardAll()
    assertFalse(sentFile.exists())
    assertNull(restore(launch()).place(other.ref))
  }

  @Test
  fun withRealWritersTheMarkerRetiresAfterTheQueueLandsAndSignOutRemovesTheFile() = runBlocking {
    val old = listen("old")
    val other = listen("keep", path = "Another book")
    val writer = DurableWriter()
    val box = launch(writer)
    restore(box)
    box.append(listOf(old, other))
    box.forgetPlace(ref)
    assertEquals(SentPlace.Removed, sentBooks()[ref.key])
    box.flush(FakeTransport())
    assertTrue(box.events.isEmpty())
    // The next POST waits for both writers, so the retired marker is on disk by then.
    box.append(listOf(listen("more", path = "Another book")))
    box.flush(FakeTransport())
    assertEquals(setOf(other.ref.key), sentBooks().keys)
    assertNull(restore(launch()).place(ref))

    box.discardAll()
    assertTrue(writer.drain())
    assertFalse(sentFile.exists())
  }

  // A marker retires once the queue it was checked against lands. An append with no cut (an
  // `unfinish`) changes that queue too, so it is checked again rather than left on disk.
  @Test
  fun anAppendWithoutACutStillRetiresAMarkerWaitingOnTheWriter() = runBlocking {
    var release: Runnable? = null
    val writer = DurableWriter(retryAfter = { _, retry -> release = retry })
    var held = true
    writer.submit { !held }
    assertFalse(writer.drain())
    val box = launch(writer)
    restore(box)
    box.forgetPlace(ref)
    assertEquals(SentPlace.Removed, sentBooks()[ref.key])
    box.append(listOf(FinishEvent("unfinish", "unfinish", ref.libraryId, "Another book", "2026-10-25T07:40:00Z")))
    held = false
    release!!.run()
    assertTrue(writer.drain())
    // A POST nobody answers waits for both writers and changes nothing else.
    box.flush(FakeTransport { throw java.io.IOException("offline") })
    assertEquals(emptySet<String>(), sentBooks().keys)
  }

  @Test
  fun onlyFreshHearingReplacesARemovalEvenIfTheOldCutIsAnsweredLate() {
    val box = launch()
    restore(box)
    val old = listen("old") as SpanEvent
    box.append(listOf(old))
    box.forgetPlace(ref)
    val empty = old.copy(id = "loaded", fromPos = 100.0, toPos = 100.2)
    val unfinish = FinishEvent("unfinish", "unfinish", ref.libraryId, ref.path, old.endedAt)
    box.append(listOf(unfinish, empty))
    assertNull(restore(launch()).place(ref))

    // A deliberate move on the new download counts, even with the clock set back.
    val move = old.copy(id = "move", start = ListeningStart.MOVED_BACK, fromPos = 40.0, toPos = 40.0,
      endedAt = "2026-10-25T07:30:00Z")
    box.append(listOf(move))
    box.apply(SyncResponse(results = listOf(SyncResult(old.id, "applied"))), listOf(old), null, null)
    val next = launch()
    assertEquals(listOf(unfinish, empty, move), next.events)
    assertEquals(40.0, restore(next).place(ref)!!.position, 0.0)
  }

  @Test
  fun aFinishAnsweredFirstStillCoversTheOlderCutAfterAClockChange() = runBlocking {
    val old = listen("old", endedAt = "2026-10-25T07:35:00Z")
    val other = listen("other", path = "Another book")
    val finish = FinishEvent("finish", "finish", ref.libraryId, ref.path, "2026-10-25T07:34:00Z")
    val first = launch()
    restore(first)
    first.append(listOf(old, other, finish))
    first.apply(SyncResponse(results = listOf(SyncResult(finish.id, "applied"))), listOf(finish), null, null)

    val next = launch()
    val places = restore(next)
    assertNull(places.place(ref))
    assertEquals(16800.0, places.place(other.ref)!!.position, 0.0)
    assertEquals(listOf(old, other), next.events)
    next.flush(FakeTransport())
    assertEquals(setOf(other.ref.key), sentBooks().keys)

    val replay = (listen("replay", endedAt = "2026-10-25T07:40:00Z", start = ListeningStart.RESTART) as SpanEvent)
      .copy(fromPos = 0.0, toPos = 15.0)
    next.append(listOf(replay))
    next.flush(FakeTransport())
    assertEquals(15.0, restore(launch()).place(ref)!!.position, 0.0)
  }

  @Test
  fun aFailedQueueWriteKeepsTheMarkerOverTheLastQueueOnDisk() = runBlocking {
    val old = listen("old")
    val other = listen("keep", path = "Another book")
    val writer = DurableWriter(retryAfter = { _, _ -> })
    val first = launch(writer)
    restore(first)
    first.append(listOf(old, other))
    assertTrue(writer.drain())
    // Hold the ordinary writer before the upload answer can rewrite the outbox.
    writer.submit { false }
    assertFalse(writer.drain())
    first.forgetPlace(ref)
    val server = FakeTransport()
    first.flush(server)
    assertEquals(listOf(old, other), server.bodies.single().events)
    assertTrue(first.events.isEmpty())

    val next = launch()
    val places = restore(next)
    assertEquals(listOf(old, other), next.events)
    assertNull(places.place(ref))
    assertEquals(16800.0, places.place(other.ref)!!.position, 0.0)
    next.flush(FakeTransport())
    assertEquals(setOf(other.ref.key), sentBooks().keys)
  }

  @Test
  fun aLegacyCutsOnlyCheckpointMergesWithTheQueuedFinishForItsAccount() {
    val old = listen("old") as SpanEvent
    val other = old.copy(id = "other", path = "Another book")
    sentFile.parentFile.mkdirs()
    sentFile.writeText("""{"account":"a","cuts":[${Wire.json.encodeToString(old)},${Wire.json.encodeToString(other)}]}""")
    val finish = FinishEvent("end", "finish", ref.libraryId, ref.path, old.endedAt)
    outbox(folder.root).append(listOf(finish))
    assertNull(restore(launch(), "b").place(other.ref))
    val restored = restore(launch())
    assertNull(restored.place(ref))
    assertEquals(other.toPos, restored.place(other.ref)!!.position, 0.0)
  }

  @Test
  fun anOfflineRelaunchRecoversASentCutThatNeverReachedTheListeningFiles() = runBlocking {
    val dir = tempDir()
    try {
      val cut = (listen("cut") as SpanEvent).copy(fromPos = 625.48, toPos = 640.73)
      val normal = File(dir, "files").apply { writeText("unwritable directory") }
      val fallback = File(dir, "no_backup/sent-places.json")
      fun open() =
        Outbox(normal, acks, DEVICE_ID, DurableWriter(retryAfter = { _, _ -> }), fallback) { clock.now }
      val first = open()
      restore(first)
      first.append(listOf(cut))
      val server = FakeTransport()
      first.flush(server)
      assertEquals(listOf(cut), server.bodies.single().events)
      assertTrue(first.events.isEmpty())

      assertNull(restore(open(), "b").place(ref))

      // The old open span is sent again under its original id. Its duplicate cannot replace
      // the newer checkpoint, even when the launch has no network afterwards.
      val second = open()
      val oldAt = iso("2026-10-25T07:32:00Z")
      val old = OpenSpan(ref.libraryId, ref.path, SpanEnd(550.0, null, null), SpanEnd(571.945, null, null), 1800.0, 1.0,
        oldAt.minusSeconds(20), oldAt, ListeningStart.RESUME, 25, "old")
      val store = MemorySpanStore().apply { save(old) }
      restore(second, store = store)
      second.flush(FakeTransport { answer(it, status = { e -> SyncResult(e.id, "duplicate") }) })
      val places = restore(open())
      assertEquals(640.73, Resume.plan(places.place(ref), null, DEVICE_ID, 25, 1800.0).position, 0.0)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun aLaterPlayThatNeverMovedDoesNotHideTheSentCutFromTheFallback() = runBlocking {
    val dir = tempDir()
    try {
      val normal = File(dir, "files").apply { writeText("unwritable directory") }
      val fallback = File(dir, "no_backup/sent-places.json")
      fun open() = Outbox(normal, acks, DEVICE_ID, DurableWriter(retryAfter = { _, _ -> }), fallback) { clock.now }
      val heard = (listen("heard", endedAt = "2026-10-25T07:30:00Z") as SpanEvent).copy(fromPos = 625.48, toPos = 640.73)
      // The next play opened at a place loaded from another device and stopped before it moved.
      val unmoved = (listen("unmoved", endedAt = "2026-10-25T07:40:00Z") as SpanEvent).copy(fromPos = 100.0, toPos = 100.0)
      val box = open()
      restore(box)
      box.append(listOf(heard))
      box.flush(FakeTransport())
      box.append(listOf(unmoved))
      box.flush(FakeTransport())
      val places = PlaceStore(null)
      val relaunched = open()
      relaunched.recoverListening("a", places, SpanRecorder(MemorySpanStore(), acks, emit = relaunched::append))
      assertEquals(640.73, places.place(ref)!!.position, 0.0)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun aCutIsSentWhenNeitherDirectoryCanKeepItsPlace() = runBlocking {
    val dir = tempDir()
    try {
      val normal = File(dir, "files").apply { writeText("") }
      val fallback = File(dir, "no_backup").apply { writeText("") }
      val o = Outbox(normal, acks, DEVICE_ID, DurableWriter(retryAfter = { _, _ -> }),
        File(fallback, "sent-places.json")) { clock.now }
      restore(o)
      val cut = listen("a")
      o.append(listOf(cut))
      val server = FakeTransport()
      o.flush(server)
      // A kill could lose what only memory holds. The server keeps it.
      assertEquals(listOf(cut), server.bodies.single().events)
      assertTrue(o.events.isEmpty())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun launchUsesTheNewerOutboxSeekEvenWhenItMovedBack() {
    val dir = tempDir()
    try {
      val seek = (listen("rewind", start = ListeningStart.MOVED_BACK) as SpanEvent).copy(
        fromPos = 300.0, toPos = 300.0, toFile = "b.mp3", toFilePos = 20.0,
      )
      outbox(dir).append(listOf(seek))
      val places = PlaceStore(File(dir, "places.json"))
      places.set(ref, LocalPlace(640.73, at = seek.time!!.minusSeconds(1)))
      val box = outbox(dir)
      box.recoverListening("a", places, SpanRecorder(MemorySpanStore(), acks, emit = box::append))
      assertEquals(LocalPlace(300.0, "b.mp3", 20.0, seek.time!!, 1.0), places.place(ref))
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun launchTakesTheLaterQueuedSeekWhenTheClockWasSetBackBetweenThem() {
    val dir = tempDir()
    try {
      val heard = (listen("heard", endedAt = "2026-10-25T07:40:00.000Z") as SpanEvent).copy(fromPos = 600.0, toPos = 640.0)
      // The wall clock went back five minutes, then the listener moved back while paused.
      val rewind = (listen("rewind", endedAt = "2026-10-25T07:35:00.000Z", start = ListeningStart.MOVED_BACK) as SpanEvent)
        .copy(fromPos = 300.0, toPos = 300.0)
      outbox(dir).append(listOf(heard, rewind))
      val places = PlaceStore(File(dir, "places.json"))
      // The rewind's own place landed: the older heard cut must not replace it.
      places.set(ref, LocalPlace(300.0, at = rewind.time!!))
      val box = outbox(dir)
      box.recoverListening("a", places, SpanRecorder(MemorySpanStore(), acks, emit = box::append))
      assertEquals(300.0, places.place(ref)!!.position, 0.0)
    } finally {
      dir.deleteRecursively()
    }
  }

  // Stay wins (row 9c-2): a queued `stay` goes as a `jump` once the server lacks
  // `listening_stay`, as it is otherwise; the stored event keeps its start and id.
  @Test
  fun aQueuedStayIsSentAsAJumpWhenTheServerNoLongerTakesIt() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a", start = ListeningStart.STAY), listen("b")))
    var takes = false
    o.takesStay = { takes }
    val t = FakeTransport { throw NoAnswer() }
    o.flush(t)
    takes = true
    o.flush(t)
    val starts = t.bodies.map { b -> b.events.map { (it as SpanEvent).start } }
    assertEquals(
      listOf(
        listOf(ListeningStart.JUMP, ListeningStart.RESUME),
        listOf(ListeningStart.STAY, ListeningStart.RESUME),
      ),
      starts,
    )
    assertEquals(listOf("a", "b"), t.bodies[0].events.map { it.id })
    assertEquals(ListeningStart.STAY, (o.events[0] as SpanEvent).start)
  }

  @Test
  fun sendsAFreshSentAtPerAttemptAndTheDeviceId() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    var fail = true
    val t = FakeTransport {
      if (fail) throw NoAnswer()
      answer(it)
    }
    o.flush(t)
    assertTrue(o.lastFlushFailed)
    clock.now = iso("2026-10-25T09:30:00.000Z")
    fail = false
    o.flush(t)
    assertEquals(listOf("2026-10-25T08:00:00.000Z", "2026-10-25T09:30:00.000Z"), t.bodies.map { it.sentAt })
    assertEquals(DEVICE_ID, t.bodies[1].deviceId)
    assertNull(t.bodies[1].clockOffset)
    assertTrue(o.events.isEmpty())
  }

  @Test
  fun keepsEverythingOnNoAnswerAnd401403404And5xx() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    o.flush(FakeTransport { throw NoAnswer() })
    for (status in listOf(401, 403, 404, 405, 500, 503)) {
      o.flush(FakeTransport { throw APIError(status) })
    }
    assertEquals(listOf("a"), o.events.map { it.id })
    assertTrue(o.couldNotSync().isEmpty())
  }

  @Test
  fun sendsInChunksOf200RoundAfterRound() = runBlocking {
    val o = outbox()
    o.append((0 until 450).map { listen("e$it") })
    val t = FakeTransport()
    o.flush(t)
    assertEquals(listOf(200, 200, 50), t.bodies.map { it.events.size })
    assertEquals("e200", t.bodies[1].events[0].id)
    assertTrue(o.events.isEmpty())
  }

  @Test
  fun halvesTheChunkOnA413OrTooManyEvents() = runBlocking {
    val o = outbox()
    o.append((0 until 300).map { listen("e$it") })
    var calls = 0
    val t = FakeTransport { body ->
      calls += 1
      if (calls == 1) throw APIError(413)
      if (calls == 2) throw APIError(400, code = "too_many_events")
      answer(body)
    }
    o.flush(t)
    assertEquals(listOf(200, 100, 50, 50, 50, 50, 50, 50), t.bodies.map { it.events.size })
    assertTrue(o.events.isEmpty())
  }

  @Test
  fun a400OnABatchResendsOneByOneOnce() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("good"), listen("bad"), listen("also-good")))
    val t = FakeTransport { body ->
      if (body.events.size > 1 || body.events[0].id == "bad") throw APIError(400, message = "invalid request")
      answer(body)
    }
    o.flush(t)
    assertEquals(
      listOf(listOf("good", "bad", "also-good"), listOf("good"), listOf("bad"), listOf("also-good")),
      t.bodies.map { b -> b.events.map { it.id } },
    )
    assertTrue(o.events.isEmpty())
    assertEquals(listOf(listOf("bad", "invalid")), failures(o))
  }

  @Test
  fun everyStatusButRejectedRemovesTheEvent() = runBlocking {
    val statuses =
      mapOf(
        "a" to SyncResult("a", "applied"),
        "b" to SyncResult("b", "duplicate"),
        "c" to SyncResult("c", "diverged", kept = "stored"),
        "d" to SyncResult("d", "not_applied", reason = "resume_behind"),
        "e" to SyncResult("e", "rejected", reason = "duration_mismatch"),
      )
    val o = outbox()
    o.append(listOf("a", "b", "c", "d", "e").map { listen(it) })
    o.flush(FakeTransport { answer(it, status = { e -> statuses[e.id] }) })
    assertTrue(o.events.isEmpty())
    assertEquals(listOf(listOf("e", "duration_mismatch")), failures(o))
    assertEquals(clock.now, o.state.lastSyncAt)
    o.discardFailed("e")
    assertTrue(o.couldNotSync().isEmpty())
  }

  @Test
  fun anEventWithNoResultWaitsForALaterTry() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a"), listen("b")))
    o.flush(FakeTransport { SyncResponse(results = listOf(SyncResult("a", "applied"))) })
    assertEquals(listOf("b"), o.events.map { it.id })
  }

  @Test
  fun keepsTheNewestHundredOnTheCouldntSyncList() = runBlocking {
    val count = Outbox.MAX_COULD_NOT_SYNC + 50
    val o = outbox()
    o.append((0 until count).map { listen("r$it") })
    o.flush(FakeTransport { answer(it, status = { e -> SyncResult(e.id, "rejected", reason = "not_found") }) })
    assertEquals(Outbox.MAX_COULD_NOT_SYNC, o.couldNotSync().size)
    assertEquals("r${count - 1}", o.couldNotSync().last().event.id)
    assertTrue(o.events.isEmpty())
  }

  @Test
  fun keepsACouldntSyncEntryThirtyDays() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("big")))
    o.flush(FakeTransport { throw APIError(413) })
    assertEquals(listOf(listOf("big", "too_large")), failures(o))
    assertEquals(1, o.couldNotSync(clock.now.addingSeconds(1.0)).size)
    assertEquals(0, o.couldNotSync(clock.now.addingSeconds(Outbox.COULD_NOT_SYNC_KEEP)).size)
  }

  @Test
  fun givesUpAnEventOlderThan89DaysUnsent() = runBlocking {
    val old = ISOTime.string(clock.now.addingSeconds(-Outbox.GIVE_UP_AGE - 60))
    val o = outbox()
    o.append(
      listOf(
        listen("old", endedAt = old),
        FinishEvent("old-finish", "finish", 3, "Author/Book", old),
        listen("new", endedAt = ISOTime.string(clock.now)),
      )
    )
    val t = FakeTransport()
    o.flush(t)
    assertEquals(listOf("new"), t.bodies.flatMap { b -> b.events.map { it.id } })
    assertEquals(listOf(listOf("old", "too_old"), listOf("old-finish", "too_old")), failures(o))
    assertTrue(o.events.isEmpty())
  }

  @Test
  fun anAnswerStillBeingAppliedWhenTheAccountLeavesWritesNothingForTheNextOne() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    var answered = false
    // Sign-out wakes on the emptied outbox (onChange) and discards while the worker's answer
    // is still being applied on its own thread.
    o.onChange = { if (o.events.isEmpty() && !answered) { answered = true; o.discardAll(); acks.clear() } }
    o.onAnswer = { _, _ -> fail("the old account's rows reached the next one") }
    o.flush(FakeTransport { answer(it, progress = listOf(row(version = 42))) })
    assertTrue(answered)
    assertNull(acks.ackVersion(ref))
  }

  @Test
  fun acknowledgesARowThatKeptThisDevicesEvent() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    var rows = emptyList<ProgressRow>()
    o.onAnswer = { r, _ -> rows = r }
    o.flush(FakeTransport { answer(it, progress = listOf(row(version = 42))) })
    assertEquals(42, acks.ackVersion(ref))
    assertEquals(listOf(42), rows.map { it.version })
  }

  // Another device's Stay held this watch's (`diverged`, `kept: stored`): the answer says so, so
  // the kept place is offered at once (`OfferThrottle.shouldShow`'s `stayHeld`).
  @Test
  fun theAnswerNamesTheBooksWhoseStayItHeld() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a", start = ListeningStart.STAY), listen("b", path = "Other", start = ListeningStart.STAY), listen("c", path = "Third")))
    o.takesStay = { true }
    var held = emptySet<BookRef>()
    o.onAnswer = { _, h -> held = h }
    o.flush(
      FakeTransport { body ->
        answer(body, status = { e -> if (e.id == "b") null else SyncResult(e.id, "diverged", kept = "stored") })
      }
    )
    assertEquals(setOf(ref), held)
  }

  // A `stay` sent as a `jump` (the server no longer takes it) was held by the usual rule.
  @Test
  fun aStaySentAsAJumpIsNotAHeldStay() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a", start = ListeningStart.STAY)))
    o.takesStay = { false }
    var held = setOf(BookRef(0, ""))
    o.onAnswer = { _, h -> held = h }
    o.flush(FakeTransport { body -> answer(body, status = { e -> SyncResult(e.id, "diverged", kept = "stored") }) })
    assertEquals(emptySet<BookRef>(), held)
  }

  @Test
  fun acknowledgesTheRowAnUnfinishHandsThisDevice() = runBlocking {
    val o = outbox()
    o.append(listOf(FinishEvent("u", "unfinish", 3, "Author/Book", "2026-10-25T08:00:00.000Z", 9)))
    o.flush(FakeTransport { answer(it, progress = listOf(row(version = 10))) })
    assertEquals(10, acks.ackVersion(ref))
  }

  @Test
  fun doesNotAcknowledgeAnotherDevicesRow() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    o.flush(FakeTransport { answer(it, progress = listOf(row(version = 42, device = "phone"))) })
    assertNull(acks.ackVersion(ref))
  }

  @Test
  fun oneFlushInFlightACallMeanwhileGoesRoundAgain() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    var second: Job? = null
    val t = FakeTransport()
    t.respond = { body ->
      if (second == null) {
        o.append(listOf(listen("b")))
        second = launch { o.flush(t) }
      }
      answer(body)
    }
    o.flush(t)
    second?.join()
    assertEquals(listOf(listOf("a"), listOf("b")), t.bodies.map { b -> b.events.map { it.id } })
    assertTrue(o.events.isEmpty())
  }

  @Test
  fun theServerClockIsMeasuredAndKept() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    o.flush(FakeTransport { answer(it, serverTime = "2026-10-25T08:00:30.000Z") })
    assertEquals(30_000.0, o.state.clockSkewMs)
  }

  @Test
  fun dropsAnEventThatIsNotFiniteAndADuplicateId() {
    val o = outbox()
    val bad =
      SpanEvent(
        id = "nan",
        libraryId = 3,
        path = "p",
        fromPos = Double.NaN,
        toPos = 1.0,
        startedAt = "x",
        endedAt = "x",
        start = ListeningStart.RESUME,
      )
    o.append(listOf(bad, listen("a"), listen("a")))
    assertEquals(listOf("a"), o.events.map { it.id })
  }

  @Test
  fun persistsAcrossLaunches() = runBlocking {
    val dir = tempDir()
    try {
      val o = outbox(dir)
      o.append(listOf(listen("a"), listen("b")))
      o.flush(
        FakeTransport {
          answer(
            it,
            status = { e ->
              if (e.id == "b") SyncResult("b", "rejected", reason = "not_found") else SyncResult(e.id, "duplicate")
            },
          )
        }
      )
      o.append(listOf(listen("c")))
      val again = outbox(dir)
      assertEquals(listOf("c"), again.events.map { it.id })
      assertEquals(listOf("b"), again.couldNotSync().map { it.event.id })
      again.discardAll()
      assertEquals(0, outbox(dir).unsentCount)
    } finally {
      dir.deleteRecursively()
    }
  }

  // `lastFlushFailed` is what the 15 s cut and Sync status read: discarding what waits ends the
  // failed state a flush left (the Swift test also applies a background answer, which Wear has not).
  @Test
  fun aDiscardEndsAFailedFlush() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("b")))
    o.flush(FakeTransport { throw APIError(503) })
    assertTrue(o.lastFlushFailed)
    o.discardAll()
    assertFalse(o.lastFlushFailed)
  }

  // Offline, the retry timer's attempts must not read as reachable: the 15 s cut reads this flag,
  // and each cut sends another event and another attempt.
  @Test
  fun aFailedFlushStaysFailedUntilTheServerAnswers() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    o.flush(FakeTransport { throw NoAnswer() })
    assertTrue(o.lastFlushFailed)
    val t = HeldTransport()
    val retry = launch { o.flush(t) }
    t.requestArrives()
    assertTrue("a retry in flight is no answer yet", o.lastFlushFailed)
    t.refuse(NoAnswer())
    retry.join()
    assertTrue(o.lastFlushFailed)
    val again = launch { o.flush(t) }
    t.requestArrives()
    assertTrue(o.lastFlushFailed)
    t.reply(answer(t.bodies[1]))
    again.join()
    assertFalse(o.lastFlushFailed)
    assertTrue(o.events.isEmpty())
  }

  @Test
  fun oldEventsGivenUpLeaveNothingFailed() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    o.flush(FakeTransport { throw NoAnswer() })
    assertTrue(o.lastFlushFailed)
    clock.now = clock.now.addingSeconds(Outbox.GIVE_UP_AGE + 3600)
    o.flush(FakeTransport())
    assertTrue(o.events.isEmpty())
    assertFalse(o.lastFlushFailed)
  }

  // The caller that was coalesced may hold a newer address or token (a repick, a sign-in again).
  @Test
  fun aCallDuringAFlushSendsTheNextRoundThroughItsOwnTransport() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    val first = HeldTransport()
    val running = launch { o.flush(first) }
    first.requestArrives()
    o.append(listOf(listen("b")))
    val newer = FakeTransport()
    val coalesced = launch { o.flush(newer) }
    yield()
    first.reply(answer(first.bodies[0]))
    running.join()
    coalesced.join()
    assertEquals(listOf("b"), newer.bodies.flatMap { b -> b.events.map { it.id } })
    assertEquals(1, first.bodies.size)
    assertTrue(o.events.isEmpty())
  }

  @Test
  fun aCallRightAfterAFlushEndsStartsAnother() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    o.flush(FakeTransport())
    o.append(listOf(listen("b")))
    val t = FakeTransport()
    o.flush(t)
    assertEquals(listOf("b"), t.bodies.flatMap { b -> b.events.map { it.id } })
    assertTrue(o.events.isEmpty())
  }

  // Signing out while a request is out: its answer is no longer this outbox's.
  @Test
  fun anAnswerAfterADiscardIsDropped() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    val t = HeldTransport()
    val flush = launch { o.flush(t) }
    t.requestArrives()
    o.discardAll()
    var told = false
    o.onAnswer = { _, _ -> told = true }
    t.reply(answer(t.bodies[0], progress = listOf(row(version = 9))))
    flush.join()
    assertNull(o.state.clockSkewMs)
    assertNull(acks.ackVersion(ref))
    assertFalse(told)
  }

  @Test
  fun aFailureAfterADiscardIsDropped() = runBlocking {
    for (failure in listOf<Throwable>(APIError(503), APIError(400), NoAnswer())) {
      val o = outbox()
      o.append(listOf(listen("a"), listen("b")))
      val t = HeldTransport()
      val flush = launch { o.flush(t) }
      t.requestArrives()
      o.discardAll()
      t.refuse(failure)
      flush.join()
      assertFalse(o.lastFlushFailed)
      assertTrue(o.couldNotSync().isEmpty())
      assertEquals("nothing more is sent", 1, t.bodies.size)
    }
  }

  @Test
  fun aFlushAfterADiscardSendsTheNewAccountsEventsThroughItsTransport() = runBlocking {
    val o = outbox()
    o.append(listOf(listen("a")))
    val old = HeldTransport()
    val running = launch { o.flush(old) }
    old.requestArrives()
    o.discardAll()
    o.append(listOf(listen("b")))
    val fresh = FakeTransport()
    val next = launch { o.flush(fresh) }
    yield()
    old.reply(answer(old.bodies[0]))
    running.join()
    next.join()
    assertEquals(listOf("b"), fresh.bodies.flatMap { b -> b.events.map { it.id } })
    assertTrue(o.events.isEmpty())
  }

  // An outbox that can't be read now (another build's format) holds listening: the next save must
  // not write over it.
  @Test
  fun anUnreadableOutboxIsSetAsideAndJoinsOnceItReads() {
    val dir = tempDir()
    try {
      File(dir, "outbox.json").writeText("not this build's format")
      val unreadable = outbox(dir)
      assertTrue(unreadable.events.isEmpty())
      unreadable.append(listOf(listen("new")))
      val aside = dir.list()!!.first { it.startsWith("outbox-unread-") }
      assertEquals("not this build's format", File(dir, aside).readText())
      // It stays aside while it can't be read.
      assertEquals(listOf("new"), outbox(dir).events.map { it.id })
      assertTrue(dir.list()!!.contains(aside))
      // It reads now: it joins (an id already waiting once), and is gone.
      JsonFile(File(dir, aside), kotlinx.serialization.builtins.ListSerializer(ListeningEvent.serializer()))
        .write(listOf(listen("old"), listen("new")))
      val joined = outbox(dir)
      assertEquals(listOf("old", "new"), joined.events.map { it.id })
      assertFalse(dir.list()!!.contains(aside))
      assertEquals("kept in the outbox itself", listOf("old", "new"), outbox(dir).events.map { it.id })
    } finally {
      dir.deleteRecursively()
    }
  }

  // A damaged outbox that can't be moved aside either stays in the way: the next save must not
  // write over it (or remove it, as an empty outbox does), and moves it once it can.
  @Test
  fun anOutboxThatCantBeMovedAsideIsNeverWrittenOver() {
    val dir = tempDir()
    try {
      val main = File(dir, "outbox.json").apply { writeText("not this build's format") }
      dir.setWritable(false)
      // Where permissions hold (not as root).
      assumeFalse(dir.canWrite())
      val o = outbox(dir)
      o.append(listOf(listen("first")))
      o.apply(answer(SyncRequest(DEVICE_ID, events = o.events)), o.events, null, null)
      assertTrue(o.events.isEmpty())
      assertEquals("not this build's format", main.readText())
      dir.setWritable(true)
      // Written with the next save, the damaged file aside by then.
      o.append(listOf(listen("second")))
      val aside = dir.list()!!.first { it.startsWith("outbox-unread-") }
      assertEquals("not this build's format", File(dir, aside).readText())
      assertEquals(listOf("second"), outbox(dir).events.map { it.id })
    } finally {
      dir.setWritable(true)
      dir.deleteRecursively()
    }
  }

  // Not to be read, and not to be moved either: once it reads, what it holds joins what came since.
  @Test
  fun anOutboxStillInTheWayJoinsAtTheNextSaveOnceItReads() {
    val dir = tempDir()
    try {
      val main = File(dir, "outbox.json")
      JsonFile(main, kotlinx.serialization.builtins.ListSerializer(ListeningEvent.serializer())).write(listOf(listen("kept")))
      main.setReadable(false)
      dir.setWritable(false)
      assumeFalse(main.canRead() || dir.canWrite())
      val o = outbox(dir)
      assertEquals(0, o.unsentCount)
      dir.setWritable(true)
      main.setReadable(true)
      o.append(listOf(listen("new")))
      assertEquals(listOf("kept", "new"), o.events.map { it.id })
      assertEquals(listOf("kept", "new"), outbox(dir).events.map { it.id })
      assertFalse(dir.list()!!.any { it.startsWith("outbox-unread-") })
    } finally {
      dir.setWritable(true)
      dir.deleteRecursively()
    }
  }

  // A discard drops a file still in the way too: it is never the next account's listening.
  @Test
  fun aDiscardDropsAnOutboxStillInTheWay() {
    val dir = tempDir()
    try {
      val main = File(dir, "outbox.json")
      JsonFile(main, kotlinx.serialization.builtins.ListSerializer(ListeningEvent.serializer())).write(listOf(listen("theirs")))
      main.setReadable(false)
      dir.setWritable(false)
      assumeFalse(main.canRead() || dir.canWrite())
      val o = outbox(dir)
      dir.setWritable(true)
      main.setReadable(true)
      o.discardAll()
      o.append(listOf(listen("mine")))
      assertEquals(listOf("mine"), o.events.map { it.id })
      assertEquals(listOf("mine"), outbox(dir).events.map { it.id })
    } finally {
      dir.setWritable(true)
      dir.deleteRecursively()
    }
  }

  @Test
  fun aDiscardRemovesWhatWasSetAside() {
    val dir = tempDir()
    try {
      File(dir, "outbox.json").writeText("damaged")
      val o = outbox(dir)
      o.discardAll()
      assertFalse("never joined to the next account's", dir.list()!!.any { it.startsWith("outbox-unread-") })
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun theBodyEncodesExactlyOneClock() {
    val fg = SyncRequest("d", sentAt = "2026-10-25T08:00:00.000Z", events = emptyList())
    val bg = SyncRequest("d", clockOffset = -3.0, events = emptyList())
    val a = Wire.json.parseToJsonElement(Wire.json.encodeToString(SyncRequest.serializer(), fg)).jsonObject
    val b = Wire.json.parseToJsonElement(Wire.json.encodeToString(SyncRequest.serializer(), bg)).jsonObject
    assertEquals(setOf("device_id", "sent_at", "events"), a.keys)
    assertEquals(setOf("device_id", "clock_offset", "events"), b.keys)
  }

  // Wear's own: a stored event is the event sent (the same snake_case JSON, `kind` included).
  @Test
  fun anEventRoundTripsThroughTheWire() {
    val events = listOf(listen("a"), FinishEvent("f", "finish", 3, "Author/Book", "2026-10-25T08:00:00.000Z", 4))
    val serializer = kotlinx.serialization.builtins.ListSerializer(ListeningEvent.serializer())
    val text = Wire.json.encodeToString(serializer, events)
    assertTrue(text.contains("\"kind\":\"listen\""))
    assertTrue(text.contains("\"from_pos\":14400.0"))
    assertTrue(text.contains("\"base_version\":41"))
    assertFalse(text.contains("from_file"))
    assertEquals(events, Wire.json.decodeFromString(serializer, text))
  }
}

class ClockSkewTest {
  @Test
  fun measuresFromTheMiddleOfTheRequest() {
    val sentAt = iso("2026-10-25T07:41:00.000Z")
    assertEquals(20_000.0, ClockSkew.of("2026-10-25T07:41:21.000Z", sentAt, sentAt.addingSeconds(2.0)))
    assertNull(ClockSkew.of("not a time", sentAt, sentAt))
    assertNull(ClockSkew.of(null, sentAt, sentAt))
  }

  @Test
  fun readsTheServersNanosecondTimes() {
    val a = iso("2026-10-25T07:41:21.123456789Z")
    assertEquals(iso("2026-10-25T07:41:21Z").epochSeconds + 0.123456789, a.epochSeconds, 1e-6)
    assertEquals(ISOTime.parse("2026-10-25T07:41:21.000Z"), ISOTime.parse("2026-10-25T08:41:21+01:00"))
  }
}

class AckAndOfferTest {
  private val ref = BookRef(3, "Author/Book")

  @Test
  fun staysHeldNamesOnlyAStayTheServerKeptTheStoredRowOver() {
    val events = listOf(listen("a", start = ListeningStart.STAY), listen("b", path = "B"), listen("c", path = "C", start = ListeningStart.STAY), listen("d", path = "D", start = ListeningStart.STAY))
    val results =
      mapOf(
        "a" to SyncResult("a", "diverged", kept = "stored"),
        "b" to SyncResult("b", "diverged", kept = "stored"),
        "c" to SyncResult("c", "diverged", kept = "event"),
        "d" to SyncResult("d", "applied"),
      )
    assertEquals(setOf(ref), AckRules.staysHeld(events, results))
  }

  @Test
  fun keptMineAcknowledgesOnlyThisDevicesRowThatKeptItsEvent() {
    val events = listOf(listen("a"))
    fun results(status: String, kept: String? = null) = mapOf("a" to SyncResult("a", status, kept = kept))
    val mine = row(version = 1, device = "me")
    assertTrue(AckRules.keptMine(mine, "me", events, results("applied")))
    assertTrue(AckRules.keptMine(mine, "me", events, results("diverged", kept = "event")))
    assertFalse(AckRules.keptMine(mine, "me", events, results("diverged", kept = "stored")))
    assertFalse(AckRules.keptMine(mine, "me", events, results("not_applied")))
    assertFalse(AckRules.keptMine(row(version = 1, device = "other"), "me", events, results("applied")))
    assertFalse(AckRules.keptMine(row(path = "Else", version = 1, device = "me"), "me", events, results("applied")))
  }

  @Test
  fun ackNeverLowersAndResumeAcksAVersionAboveZero() {
    val acks = AckStore(null)
    assertNull(acks.ackVersion(ref))
    acks.ackResume(row(version = 0))
    assertNull("a cold start stays 0", acks.ackVersion(ref))
    acks.ackResume(row(version = 9))
    acks.ack(ref, 5)
    assertEquals(9, acks.ackVersion(ref))
  }

  @Test
  fun answeringAnOfferAcksTheRowAndNotesTheKey() {
    val dir = tempDir()
    try {
      val file = File(dir, "acks.json")
      val acks = AckStore(file)
      acks.ack(ref, 12)
      acks.answerOffer(ref, row(version = 7), "k1")
      assertEquals("never lowered", 12, acks.ackVersion(ref))
      for (i in 0 until 30) acks.answerOffer(ref, row(version = 13), "k$i")
      val reread = AckStore(file)
      assertEquals(13, reread.ackVersion(ref))
      assertEquals(AckStore.MAX_ANSWERED, reread.answered(ref).size)
      assertEquals("k29", reread.answered(ref).last())
    } finally {
      dir.deleteRecursively()
    }
  }

  // An offer swiped away unanswered (the phone's ignoreOffer): noted, nothing acknowledged.
  @Test
  fun ignoringAnOfferNotesTheKeyAndAcksNothing() {
    val acks = AckStore(null)
    acks.ack(ref, 4)
    val key = "other-device|2026-10-08T10:00:00Z"
    acks.ignoreOffer(ref, key)
    acks.ignoreOffer(ref, key)
    assertEquals(listOf(key), acks.answered(ref))
    assertEquals("nothing acknowledged", 4, acks.ackVersion(ref))
    assertNull(
      "not offered again",
      Offers.offerOf(progressRow(version = 5), "this-device", 4, 105.0, acks.answered(ref)),
    )
    // Jump or Stay noted it already: closing the sheet after either changes nothing.
    acks.answerOffer(ref, row(version = 9), "k2")
    acks.ignoreOffer(ref, "k2")
    assertEquals(listOf(key, "k2"), acks.answered(ref))
    assertEquals(9, acks.ackVersion(ref))
  }

  private fun progressRow(
    position: Double = 400.0,
    finished: Boolean = false,
    version: Int = 3,
    device: String = "other-device",
    name: String? = null,
    other: OtherPlace? = null,
  ) =
    ProgressRow(
      libraryId = 2,
      path = "A/Book.m4b",
      position = position,
      duration = 1000.0,
      finished = finished,
      playbackSpeed = 1.0,
      version = version,
      deviceId = device,
      updatedAt = "2026-10-08T10:00:00Z",
      deviceName = name,
      otherPlace = other,
    )

  private val other = OtherPlace(900.0, "watch", "Chris's Watch", "2026-10-08T11:00:00Z")

  @Test
  fun offersTheKeptRowOfAnotherDeviceAtAnUnseenVersion() {
    assertEquals(
      PlaceOffer(400.0, "Pixel", "other-device|2026-10-08T10:00:00Z"),
      Offers.offerOf(progressRow(version = 4, name = "Pixel"), "this-device", 3, 105.0),
    )
    assertNull(Offers.offerOf(progressRow(version = 3), "this-device", 3, 105.0))
    assertNull(Offers.offerOf(progressRow(device = "this-device"), "this-device", 0, 105.0))
    assertNull(Offers.offerOf(progressRow(finished = true), "this-device", 0, 105.0))
    assertNull(Offers.offerOf(progressRow(), "this-device", 0, 371.0))
    assertEquals(400.0, Offers.offerOf(progressRow(), "this-device", 0, 369.0)?.position)
    assertEquals("", Offers.offerOf(progressRow(), "this-device", null, 105.0)?.deviceName)
  }

  @Test
  fun elseTheRowsOtherPlaceUntilAnswered() {
    val r = progressRow(device = "this-device", other = other)
    assertEquals(
      PlaceOffer(900.0, "Chris's Watch", "watch|2026-10-08T11:00:00Z"),
      Offers.offerOf(r, "this-device", 3, 400.0),
    )
    assertNull(Offers.offerOf(r, "this-device", 3, 400.0, listOf("watch|2026-10-08T11:00:00Z")))
    val mine = other.copy(deviceId = "this-device")
    assertNull(Offers.offerOf(progressRow(device = "this-device", other = mine), "this-device", 3, 400.0))
    assertNull(Offers.offerOf(r, "this-device", 3, 880.0))
    val both = progressRow(version = 9, other = other)
    assertEquals(400.0, Offers.offerOf(both, "this-device", 3, 105.0)?.position)
    assertEquals(
      900.0,
      Offers.offerOf(both, "this-device", 3, 105.0, listOf("other-device|2026-10-08T10:00:00Z"))?.position,
    )
    assertNull(Offers.offerOf(null, "this-device", 3, 105.0))
  }

  @Test
  fun aDevicePlayingOnIsOfferedOnceInTenMinutes() {
    val throttle = OfferThrottle()
    val t0 = java.time.Instant.now()
    val first = PlaceOffer(800.0, "Tablet", "tablet|2026-10-08T11:50:00Z")
    assertTrue(throttle.shouldShow(first, ref, t0))
    assertFalse(
      "each offer once per launch",
      throttle.shouldShow(first, ref, t0.addingSeconds(Offers.OFFER_REPEAT * 2)),
    )
    val next = PlaceOffer(815.0, "Tablet", "tablet|2026-10-08T11:50:15Z")
    assertFalse(throttle.shouldShow(next, ref, t0.addingSeconds(15.0)))
    val later = PlaceOffer(900.0, "Tablet", "tablet|2026-10-08T12:00:15Z")
    assertTrue(throttle.shouldShow(later, ref, t0.addingSeconds(Offers.OFFER_REPEAT)))
    assertTrue("per book", throttle.shouldShow(next, BookRef(9, "other"), t0))
  }

  // This watch's Stay came back held by the other device's: the place kept is offered at once, not
  // ten minutes after that device's last offer, and still once per launch.
  @Test
  fun aStayHeldOffersTheKeptPlaceAtOnce() {
    val throttle = OfferThrottle()
    val t0 = java.time.Instant.now()
    val first = PlaceOffer(800.0, "Phone", "phone|2026-10-08T11:50:00Z")
    assertTrue(throttle.shouldShow(first, ref, t0))
    val stayed = PlaceOffer(800.0, "Phone", "phone|2026-10-08T11:50:20Z")
    assertFalse(throttle.shouldShow(stayed, ref, t0.addingSeconds(30.0)))
    assertTrue(throttle.shouldShow(stayed, ref, t0.addingSeconds(30.0), stayHeld = true))
    assertFalse("once per launch", throttle.shouldShow(stayed, ref, t0.addingSeconds(40.0), stayHeld = true))
  }
}
