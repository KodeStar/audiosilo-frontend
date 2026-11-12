// Ported from watch-core/Tests/WatchCoreTests/SpanRecorderTests.swift (itself
// store-listening.test.ts, the span lifecycle, and the event-building cases of
// listening-outbox.test.ts, plus the base_version rules).
package app.audiosilo.wear.core

import java.util.UUID
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private val folder = BookRef(2, "A/Folder")
private val book = PlayingBook(folder, 100.0)

private fun at(pos: Double, file: String? = "A/Folder/1.mp3", filePos: Double? = null) =
  SpanEnd(pos, file, if (file == null) null else (filePos ?: pos))

class SpanRecorderTest {
  private lateinit var clock: TestClock
  private lateinit var store: MemorySpanStore
  private lateinit var acks: AckStore
  private val emitted = ArrayList<ListeningEvent>()
  private var ids = 0

  @Before
  fun setUp() {
    clock = TestClock()
    store = MemorySpanStore()
    acks = AckStore(null)
    emitted.clear()
    ids = 0
  }

  private fun recorder() =
    SpanRecorder(
      store,
      acks,
      clock = { clock.now },
      newId = {
        ids += 1
        "e$ids"
      },
      emit = { emitted += it },
    )

  private val listens: List<SpanEvent>
    get() = emitted.filterIsInstance<SpanEvent>()

  private val finishes: List<FinishEvent>
    get() = emitted.filterIsInstance<FinishEvent>()

  // The stored span goes only once its event is kept: a kill between the two sends the span twice
  // under its one id (`duplicate`), the other way round it would be lost.
  @Test
  fun theStoredSpanStaysUntilItsEventIsKept() {
    val storedAtEmit = ArrayList<OpenSpan?>()
    val r = SpanRecorder(store, acks, { clock.now }, { "e" }, { storedAtEmit += store.stored })
    r.open(book, at(5.0), 1.0)
    clock.advance(10.0)
    r.close(at(15.0))
    assertNotNull(storedAtEmit[0])
    assertNull(store.stored)

    storedAtEmit.clear()
    store.stored =
      OpenSpan(2, "A/Folder", at(5.0), at(15.0), 100.0, 1.0, clock.now, clock.now.addingSeconds(10.0),
        ListeningStart.RESUME, 0, "left")
    val next = SpanRecorder(store, acks, { clock.now }, { "e" }, { storedAtEmit += store.stored })
    next.recover()
    assertNotNull(storedAtEmit[0])
    assertNull(store.stored)
  }

  @Test
  fun aPlayToAPauseIsOneSpanWithBothFilePlaces() {
    acks.ack(folder, 41)
    val r = recorder()
    r.open(book, at(5.0, "A/Folder/2.mp3", 5.0), 1.0)
    clock.advance(55.0)
    r.close(at(60.0, "A/Folder/10.mp3", 10.0))
    assertEquals(1, listens.size)
    val e = listens[0]
    assertEquals(listOf(5.0, 60.0), listOf(e.fromPos, e.toPos))
    assertEquals("A/Folder/2.mp3", e.fromFile)
    assertEquals("A/Folder/10.mp3", e.toFile)
    assertEquals(10.0, e.toFilePos)
    assertEquals(100.0, e.duration)
    assertEquals(ListeningStart.RESUME, e.start)
    assertEquals(41, e.baseVersion)
    assertEquals("2026-10-25T07:00:00.000Z", e.startedAt)
    assertEquals("2026-10-25T07:00:55.000Z", e.endedAt)
    assertNull("the close clears the stored span", store.stored)
  }

  @Test
  fun aStopNoticedLateEndsTheSpanWhenTheAudioStopped() {
    val r = recorder()
    r.open(book, at(5.0), 1.0)
    val stopped = clock.now.addingSeconds(20.0)
    clock.advance(3600.0) // the app was suspended; the system had paused the player
    r.close(at(25.0), stoppedAt = stopped)
    assertEquals("2026-10-25T07:00:20.000Z", listens[0].endedAt)
    // Never after now, never before the start.
    r.open(book, at(25.0), 1.0)
    r.close(at(26.0), stoppedAt = clock.now.addingSeconds(-7200.0))
    assertEquals(listens[1].startedAt, listens[1].endedAt)
    r.open(book, at(26.0), 1.0)
    clock.advance(10.0)
    r.close(at(36.0), stoppedAt = clock.now.addingSeconds(60.0))
    assertEquals(clock.now, ISOTime.parse(listens[2].endedAt))
  }

  @Test
  fun theTickCutsWhileReachableAndTheNextContinues() {
    val r = recorder()
    r.open(book, at(5.0), 1.0)
    clock.advance(15.0)
    r.tick(book, at(20.0), playing = true, reachable = true, speed = 1.0)
    clock.advance(10.0)
    r.close(at(30.0))
    assertEquals(
      listOf(listOf("RESUME", "5.0", "20.0"), listOf("CONTINUE", "20.0", "30.0")),
      listens.map { listOf(it.start.name, "${it.fromPos}", "${it.toPos}") },
    )
  }

  @Test
  fun offlineTheTickKeepsTheSpanUntilAnHour() {
    val r = recorder()
    r.open(book, at(1.0), 1.0)
    for (i in 0 until 8 * 60 + 2) {
      clock.advance(15.0)
      r.tick(book, at((2 + i).toDouble()), playing = true, reachable = false, speed = 1.0)
    }
    assertEquals(listOf(ListeningStart.RESUME, ListeningStart.CONTINUE), listens.map { it.start })
    for (e in listens) {
      val s = ISOTime.parse(e.endedAt)!!.secondsSince(ISOTime.parse(e.startedAt)!!)
      assertTrue("$s", s >= 3600 && s < 3660)
    }
    assertNotNull("one still open", r.span)
  }

  @Test
  fun aSeekWhilePlayingEndsTheSpanWhereItWas() {
    val r = recorder()
    r.open(book, at(30.0), 1.0)
    clock.advance(5.0)
    r.move(book, to = at(70.0), from = at(35.0), playing = true, speed = 1.0)
    clock.advance(5.0)
    r.move(book, to = at(10.0), from = at(75.0), playing = true, speed = 1.0)
    clock.advance(2.0)
    r.close(at(12.0))
    assertEquals(
      listOf(ListeningStart.RESUME, ListeningStart.JUMP, ListeningStart.MOVED_BACK),
      listens.map { it.start },
    )
    assertEquals(listOf(30.0, 70.0, 10.0), listens.map { it.fromPos })
    assertEquals(listOf(35.0, 75.0, 12.0), listens.map { it.toPos })
  }

  @Test
  fun aSeekWhilePausedSendsTheMoveAsASpanOfItsOwn() {
    acks.ack(folder, 41)
    val r = recorder()
    r.open(book, at(30.0), 1.0)
    clock.advance(1.0)
    r.close(at(30.0))
    emitted.clear()
    r.move(book, to = at(80.0, "A/Folder/10.mp3", 30.0), from = null, playing = false, speed = 1.0)
    assertEquals(1, listens.size)
    assertEquals(80.0, listens[0].fromPos, 0.0)
    assertEquals(80.0, listens[0].toPos, 0.0)
    assertEquals("A/Folder/10.mp3", listens[0].toFile)
    assertEquals(30.0, listens[0].toFilePos)
    assertEquals(ListeningStart.JUMP, listens[0].start)
    assertEquals(41, listens[0].baseVersion)
    // The next play begins with the same reason.
    r.open(book, at(80.0), 1.0)
    assertEquals(ListeningStart.JUMP, r.span?.start)
  }

  @Test
  fun anExplicitZeroIsARestartAndAPlaceAJump() {
    val r = recorder()
    r.prepareStart(ListeningStart.RESTART)
    r.open(book, at(0.0), 1.0)
    clock.advance(4.0)
    r.close(at(4.0))
    r.prepareStart(ListeningStart.JUMP)
    r.open(book, at(40.0), 1.0)
    clock.advance(5.0)
    r.close(at(45.0))
    assertEquals(listOf(ListeningStart.RESTART, ListeningStart.JUMP), listens.map { it.start })
  }

  @Test
  fun aFinishedBookStartedAgainSendsUnfinishThenARestartSpan() {
    acks.ack(folder, 41)
    val r = recorder()
    r.prepareStart(ListeningStart.RESTART, unfinish = true)
    r.open(book, at(0.5), 1.0)
    clock.advance(6.0)
    r.close(at(6.0))
    assertEquals(2, emitted.size)
    val un = emitted[0] as FinishEvent
    assertEquals("unfinish", un.kind)
    assertEquals(41, un.baseVersion)
    assertEquals(listOf(ListeningStart.RESTART), listens.map { it.start })
    // Paused and played again: the unfinish went once.
    r.open(book, at(6.0), 1.0)
    clock.advance(5.0)
    r.close(at(11.0))
    assertEquals(listOf("unfinish"), finishes.map { it.kind })
  }

  @Test
  fun anUnfinishOwedByABookThatNeverPlayedIsNotCarriedToTheNext() {
    val other = PlayingBook(BookRef(2, "B/Other"), 100.0)
    val r = recorder()
    // A finished book loaded to start again, never played (the speaker declined), then another book
    // loaded and played.
    r.prepareStart(ListeningStart.RESTART, unfinish = true)
    r.prepareStart(ListeningStart.RESUME)
    r.open(other, at(30.0, "B/Other/1.mp3"), 1.0)
    clock.advance(6.0)
    r.close(at(36.0, "B/Other/1.mp3"))
    assertEquals(0, finishes.size)
    assertEquals(listOf(ListeningStart.RESUME), listens.map { it.start })
  }

  @Test
  fun theNaturalEndClosesTheSpanThenSendsFinishOnce() {
    val r = recorder()
    r.open(book, at(45.0), 1.0)
    clock.advance(5.0)
    r.finish(book, at(50.0))
    r.finish(book, null) // "mark finished" from the end screen
    assertEquals(1, listens.size)
    assertEquals(listOf("finish"), finishes.map { it.kind })
    // Playing it again clears the mark.
    r.open(book, at(0.0), 1.0)
    r.finish(book, at(0.0))
    assertEquals(2, finishes.size)
  }

  @Test
  fun afterStayTheNextSpanBeginsAsAJump() {
    val r = recorder()
    r.standBy(book, null, playing = false, speed = 1.0)
    r.open(book, at(5.0), 1.0)
    clock.advance(4.0)
    r.close(at(9.0))
    assertEquals(listOf(ListeningStart.JUMP), listens.map { it.start })
  }

  @Test
  fun stayWhilePlayingCutsIntoAJump() {
    val r = recorder()
    r.open(book, at(5.0), 1.0)
    clock.advance(4.0)
    r.standBy(book, at(9.0), playing = true, speed = 1.0)
    assertEquals(listOf(ListeningStart.RESUME), listens.map { it.start })
    assertEquals(ListeningStart.JUMP, r.span?.start)
  }

  @Test
  fun aRateChangeCutsTheSpanAndTheNextRunsAtTheNewSpeed() {
    val r = recorder()
    r.open(book, at(5.0), 1.0)
    clock.advance(10.0)
    r.cut(book, at(15.0), playing = true, speed = 1.5)
    clock.advance(10.0)
    r.close(at(30.0))
    assertNull(listens[0].playbackSpeed)
    assertEquals(1.5, listens[1].playbackSpeed)
  }

  @Test
  fun emptySpansAreDroppedUnlessADeliberateMove() {
    val r = recorder()
    r.open(book, at(5.0), 1.0)
    r.close(at(5.0))
    assertTrue(emitted.isEmpty())
    r.prepareStart(ListeningStart.JUMP)
    r.open(book, at(5.0), 1.0)
    r.close(at(5.0))
    assertEquals(listOf(ListeningStart.JUMP), listens.map { it.start })
  }

  // A stop right behind a move: its still event can come back `older` when sent apart from the span
  // before it, so the next span carries the move, as after a move made while paused.
  @Test
  fun aMoveNothingWasHeardAfterGivesTheNextSpanItsReason() {
    val r = recorder()
    r.open(book, at(80.0), 1.0)
    clock.advance(10.0)
    r.move(book, to = at(10.0), from = at(90.0), playing = true, speed = 1.0)
    r.close(at(10.0), stoppedAt = clock.now)
    assertEquals(listOf(ListeningStart.RESUME, ListeningStart.MOVED_BACK), listens.map { it.start })
    assertEquals(ListeningStart.MOVED_BACK, r.nextStart)
    clock.advance(30.0)
    r.open(book, at(10.0), 1.0)
    assertEquals(ListeningStart.MOVED_BACK, r.span?.start)
    assertEquals("taken once", ListeningStart.RESUME, r.nextStart)
  }

  @Test
  fun aMoveHeardForASecondSaysItAllItself() {
    val r = recorder()
    r.prepareStart(ListeningStart.JUMP)
    r.open(book, at(80.0), 1.0)
    clock.advance(1.0)
    r.close(at(81.0))
    r.open(book, at(81.0), 1.0)
    assertEquals(ListeningStart.RESUME, r.span?.start)
  }

  @Test
  fun anEmptySpanThatWasNoMoveLeavesTheNextSpanAlone() {
    val r = recorder()
    r.open(book, at(5.0), 1.0)
    r.close(at(5.0))
    assertTrue(emitted.isEmpty())
    assertEquals(ListeningStart.RESUME, r.nextStart)
  }

  @Test
  fun aCutRightBehindAMoveKeepsTheMovesReason() {
    val r = recorder()
    r.prepareStart(ListeningStart.MOVED_BACK)
    r.open(book, at(10.0), 1.0)
    r.cut(book, at(10.0), playing = true, speed = 1.5)
    assertEquals(ListeningStart.MOVED_BACK, r.span?.start)
    clock.advance(15.0)
    r.cut(book, at(25.0), playing = true, speed = 1.5)
    assertEquals(ListeningStart.CONTINUE, r.span?.start)
  }

  @Test
  fun stayRightBehindAMoveIsStillAJump() {
    val r = recorder()
    r.prepareStart(ListeningStart.MOVED_BACK)
    r.open(book, at(10.0), 1.0)
    r.standBy(book, at(10.0), playing = true, speed = 1.0)
    assertEquals(ListeningStart.JUMP, r.span?.start)
  }

  @Test
  fun anotherBooksMoveIsNotCarriedToTheBookOpening() {
    val r = recorder()
    r.prepareStart(ListeningStart.JUMP)
    r.open(book, at(10.0), 1.0)
    val other = PlayingBook(BookRef(2, "A/Other"), 50.0)
    r.open(other, at(1.0, "A/Other/1.mp3"), 1.0)
    assertEquals("A/Other", r.span?.path)
    assertEquals(ListeningStart.RESUME, r.span?.start)
    assertEquals(ListeningStart.RESUME, r.nextStart)
  }

  // Previous at the book's start, every press: not a move.
  @Test
  fun aMoveToWhereThePlaceIsMovesNowhere() {
    assertTrue(Spans.movesNowhere(at(0.0), at(0.0)))
    assertTrue("a seek lands a hair off", Spans.movesNowhere(at(180.004), at(180.0)))
    assertFalse(Spans.movesNowhere(at(0.5), at(0.0)))
    assertFalse(Spans.movesNowhere(null, at(0.0)))
    assertFalse(Spans.movesNowhere(at(0.0), null))
    assertFalse(Spans.movesNowhere(at(Double.NaN), at(0.0)))
  }

  // The open span is kept every 5 s.
  @Test
  fun theKeepStoresTheSpanUpToWhereTheEngineIs() {
    val r = recorder()
    r.open(book, at(1.0), 1.0)
    clock.advance(5.0)
    r.keep(at(6.0))
    assertEquals(6.0, store.stored?.to?.pos)
    assertEquals("the id is fixed at open", "e1", store.stored?.id)
  }

  @Test
  fun theKeepNeverMovesTheSpanBack() {
    val r = recorder()
    r.open(book, at(1.0), 1.0)
    clock.advance(5.0)
    r.keep(at(6.0))
    clock.advance(5.0)
    r.keep(at(2.0))
    assertEquals(6.0, store.stored?.to?.pos)
  }

  @Test
  fun aSpanAKillLeftIsClosedAtTheNextLaunchOnce() {
    val r = recorder()
    r.open(book, at(1.0), 1.0)
    clock.advance(5.0)
    r.keep(at(6.0))
    // A kill: a new launch, the same store.
    emitted.clear()
    val next = recorder()
    next.recover()
    next.recover()
    assertEquals(1, listens.size)
    assertEquals("e1", listens[0].id)
    assertEquals(6.0, listens[0].toPos, 0.0)
    assertNull(store.stored)
  }

  @Test
  fun theFirstOpenRecoversFirst() {
    store.stored =
      OpenSpan(2, "A/Folder", at(1.0), at(20.0), 100.0, 1.0, clock.now.addingSeconds(-60.0),
        clock.now.addingSeconds(-40.0), ListeningStart.RESUME, 3, "left")
    val r = recorder()
    r.open(book, at(20.0), 1.0)
    assertEquals(listOf("left"), listens.map { it.id })
  }

  // base_version on every span: the acknowledged version at close, never below the one it opened
  // on, 0 on a cold start.
  @Test
  fun baseVersionIsZeroOnAColdStart() {
    val r = recorder()
    r.open(book, at(1.0), 1.0)
    clock.advance(5.0)
    r.close(at(6.0))
    assertEquals(0, listens[0].baseVersion)
  }

  @Test
  fun baseVersionIsTheAckAtCloseNeverLower() {
    acks.ack(folder, 41)
    val r = recorder()
    r.open(book, at(1.0), 1.0)
    acks.ack(folder, 44) // an answer acknowledged while it played
    clock.advance(5.0)
    r.close(at(6.0))
    assertEquals(44, listens[0].baseVersion)
    acks.ack(folder, 40) // never lowers
    assertEquals(44, acks.ackVersion(folder))
  }

  // The open span survives a kill as JSON (Files' open-span.json).
  @Test
  fun anOpenSpanRoundTripsThroughItsFile() {
    val dir = tempDir()
    try {
      val file = JsonFile(java.io.File(dir, "open-span.json"), OpenSpan.serializer())
      val span =
        OpenSpan(2, "A/Folder", at(1.0), at(20.0), 100.0, 1.25, iso("2026-10-25T07:00:00.123Z"),
          iso("2026-10-25T07:00:19.456Z"), ListeningStart.JUMP, 3, "left")
      file.write(span)
      assertEquals(span, file.read())
    } finally {
      dir.deleteRecursively()
    }
  }
}


class SpanEventTest {
  private fun span(change: (OpenSpan) -> OpenSpan = { it }): OpenSpan =
    change(
      OpenSpan(
        libraryId = 3,
        path = "Author/Book",
        from = SpanEnd(14400.0, "Author/Book/04.mp3", 812.4),
        to = SpanEnd(16800.0, "Author/Book/05.mp3", 1203.9),
        duration = 61200.0,
        speed = 1.2,
        startedAt = iso("2026-10-25T07:00:12.000Z"),
        endedAt = iso("2026-10-25T07:33:30.000Z"),
        start = ListeningStart.RESUME,
        baseVersion = 41,
        id = "e1",
      )
    )

  private fun json(e: ListeningEvent): Map<String, JsonElement> =
    Wire.json.parseToJsonElement(Wire.json.encodeToString(ListeningEvent.serializer(), e)).jsonObject

  /** A JSON value as the number or string it says (`14400` and `14400.0` are the same number). */
  private fun plain(v: JsonElement): Any? {
    val p = v as JsonPrimitive
    return if (p.isString) p.content else p.doubleOrNull
  }

  @Test
  fun sendsBothEndsTheFingerprintTheSpeedAndTheBase() {
    val expected =
      mapOf(
        "id" to "e1",
        "kind" to "listen",
        "library_id" to 3.0,
        "path" to "Author/Book",
        "from_pos" to 14400.0,
        "to_pos" to 16800.0,
        "from_file" to "Author/Book/04.mp3",
        "from_file_pos" to 812.4,
        "to_file" to "Author/Book/05.mp3",
        "to_file_pos" to 1203.9,
        "duration" to 61200.0,
        "playback_speed" to 1.2,
        "started_at" to "2026-10-25T07:00:12.000Z",
        "ended_at" to "2026-10-25T07:33:30.000Z",
        "start" to "resume",
        "base_version" to 41.0,
      )
    assertEquals(expected, json(Spans.event(span())).mapValues { plain(it.value) })
  }

  @Test
  fun leavesOutAHalfPairSpeedOneUnknownLengthAndBase() {
    val e =
      Spans.event(
        span {
          it.copy(
            from = SpanEnd(10.0),
            to = SpanEnd(20.0, "x.mp3"),
            speed = 1.0,
            duration = 0.0,
            baseVersion = null,
          )
        }
      )
    val json = json(e)
    for (key in listOf("from_file", "to_file", "playback_speed", "duration", "base_version")) {
      assertNull(key, json[key])
    }
  }

  @Test
  fun idsAreWhatTheServerTakes() {
    val id = UUID.randomUUID().toString().uppercase()
    assertTrue(Regex("^[A-Za-z0-9_-]{1,64}$").matches(id))
  }

  @Test
  fun aSpanThatMovedNowhereSaysNothingUnlessADeliberateMove() {
    val still: (OpenSpan) -> OpenSpan = { it.copy(endedAt = it.startedAt, to = it.from) }
    assertFalse(Spans.saysSomething(span(still)))
    assertFalse(Spans.saysSomething(span { still(it).copy(start = ListeningStart.CONTINUE) }))
    assertTrue(Spans.saysSomething(span { still(it).copy(start = ListeningStart.JUMP) }))
    assertTrue(Spans.saysSomething(span { still(it).copy(start = ListeningStart.RESTART) }))
    assertTrue(Spans.saysSomething(span()))
  }

  @Test
  fun neverClaimsMoreThanTheMaximumWallClock() {
    // Timers that stood still: a span open three days.
    val e =
      Spans.event(
        span {
          it.copy(
            endedAt = it.startedAt.addingSeconds(3.0 * 24 * 3600),
            from = it.from.copy(pos = 0.0),
            to = it.to.copy(pos = 600.0),
            speed = 2.0,
          )
        }
      )
    val wall = ISOTime.parse(e.endedAt)!!.secondsSince(ISOTime.parse(e.startedAt)!!)
    assertEquals("the audio it covered at 2x", 300.0, wall, 0.001)
    val long =
      Spans.event(
        span {
          it.copy(
            endedAt = it.startedAt.addingSeconds(3.0 * 24 * 3600),
            from = it.from.copy(pos = 0.0),
            to = it.to.copy(pos = 200_000.0),
          )
        }
      )
    val w2 = ISOTime.parse(long.endedAt)!!.secondsSince(ISOTime.parse(long.startedAt)!!)
    assertEquals(Spans.MAX_EVENT_SPAN, w2, 0.001)
  }

  // listening-outbox.test.ts "a place that is not a number is never enqueued".
  @Test
  fun aNumberThatIsNotOneIsNotFinite() {
    assertFalse(Spans.event(span { it.copy(to = it.to.copy(pos = Double.NaN)) }).isFinite)
    val e = Spans.event(span()).copy(toFilePos = Double.POSITIVE_INFINITY)
    assertFalse(e.isFinite)
    assertTrue(Spans.event(span()).isFinite)
  }
}
