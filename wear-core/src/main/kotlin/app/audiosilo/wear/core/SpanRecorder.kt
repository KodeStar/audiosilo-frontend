// Listening spans (Sync v2), a port of targets/watch/Core/SpanRecorder.swift (itself the span half
// of the phone's `src/playback/store.ts` and the event building in `listening-outbox.ts`; CROSS-REPO
// section 25, "Listening sync" in CONVENTIONS.md). The engine tells the recorder what happens; the
// recorder turns it into `listen`, `finish` and `unfinish` events for the outbox.
//
// A span OPENS when playing starts; it is CUT (closed into an event, a `continue` span opening at
// once) every 15 s while the server is reachable, on a rate change and on going to the background;
// offline it stays open and is cut only after an hour (`MAX_SPAN`). It is CLOSED on a pause, a move
// (the next span opens with the move's reason), a stop, a book switch and the end (then one
// `finish`). The open span is stored every 5 s (`OPEN_SPAN_KEEP`) with its id fixed at open, and one
// a kill left is closed into the outbox at the next launch (one a move opened and a kill cut short
// gives the launch's first span, when it is that book's and resumes this watch's own place, the
// move's reason).
package app.audiosilo.wear.core

import java.time.Instant
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlinx.serialization.Serializable

/** One end of a span: whole-book seconds, and the audio file (rel path) and seconds in it. */
@Serializable data class SpanEnd(val pos: Double, val file: String? = null, val filePos: Double? = null)

/** The span being played. */
@Serializable
data class OpenSpan(
  val libraryId: Int,
  val path: String,
  val from: SpanEnd,
  val to: SpanEnd,
  /** The audio's length (`Timeline.audio`, 0 = unknown). */
  val duration: Double,
  val speed: Double,
  val startedAt: StoredInstant,
  val endedAt: StoredInstant,
  val start: ListeningStart,
  /** The version acknowledged when it opened. */
  val baseVersion: Int? = null,
  /** Its event's id, chosen at open: a span closed twice is one event (`duplicate`). */
  val id: String,
) {
  val ref: BookRef
    get() = BookRef(libraryId, path)
}

/** The book a span belongs to and the audio's length. */
data class PlayingBook(
  val ref: BookRef,
  /** `Timeline.audio`. */
  val audioDuration: Double,
)

object Spans {
  /** A span shorter than this that moved nowhere says nothing. */
  const val EMPTY_SPAN: Double = 1.0

  /** The longest wall time an event may claim (the server refuses 24 h). */
  const val MAX_EVENT_SPAN: Double = 23.0 * 3600

  /** The longest a span stays open before it is cut, online or offline. */
  const val MAX_SPAN: Double = 3600.0

  /** How often a playing span is cut while the server is reachable. */
  const val CUT_INTERVAL: Double = 15.0

  /** How often the open span is stored while playing. */
  const val OPEN_SPAN_KEEP: Double = 5.0

  /**
   * A span's start as its event claims it: its own, unless it ran longer than `MAX_EVENT_SPAN`
   * (timers that stood still); then as long before the end as the audio it covered takes to play
   * (at least a second, at most the bound).
   */
  fun claimedStart(span: OpenSpan, endedAt: Instant): Instant {
    if (endedAt.secondsSince(span.startedAt) <= MAX_EVENT_SPAN) return span.startedAt
    val played = wallClockSeconds(abs(span.to.pos - span.from.pos), span.speed)
    val wall = min(MAX_EVENT_SPAN, max(1.0, if (played.isFinite()) played else 0.0))
    return endedAt.addingSeconds(-wall)
  }

  /**
   * A span as its `listen` event. Each end's file pair goes only whole; speed 1, an unknown length
   * and an unknown base are left out.
   */
  fun event(span: OpenSpan): SpanEvent {
    val endedAt = if (span.endedAt < span.startedAt) span.startedAt else span.endedAt
    val fromPair = span.from.file?.let { f -> span.from.filePos?.takeIf { it.isFinite() }?.let { f to it } }
    val toPair = span.to.file?.let { f -> span.to.filePos?.takeIf { it.isFinite() }?.let { f to it } }
    return SpanEvent(
      id = span.id,
      libraryId = span.libraryId,
      path = span.path,
      fromPos = nonNegative(span.from.pos),
      toPos = nonNegative(span.to.pos),
      fromFile = fromPair?.first,
      fromFilePos = fromPair?.second?.let(::nonNegative),
      toFile = toPair?.first,
      toFilePos = toPair?.second?.let(::nonNegative),
      duration = if (span.duration > 0) span.duration else null,
      playbackSpeed = if (span.speed > 0 && span.speed <= 4 && span.speed != 1.0) span.speed else null,
      startedAt = ISOTime.string(claimedStart(span, endedAt)),
      endedAt = ISOTime.string(endedAt),
      start = span.start,
      baseVersion = span.baseVersion,
    )
  }

  /**
   * `max(0, x)` that keeps a NaN a NaN (`max(0, NaN)` would send a place that is not one as the
   * start of the book): `isFinite` then keeps it out.
   */
  fun nonNegative(x: Double): Double = if (x.isNaN()) x else max(0.0, x)

  /** Whether anything was heard in a span: it ran a second, or the place moved one. */
  private fun heard(span: OpenSpan): Boolean =
    span.endedAt.secondsSince(span.startedAt) >= EMPTY_SPAN || abs(span.to.pos - span.from.pos) >= 1

  /** The starts that say a deliberate move. */
  private val MOVE_STARTS =
    setOf(ListeningStart.JUMP, ListeningStart.MOVED_BACK, ListeningStart.RESTART, ListeningStart.STAY)

  /** Whether a span carries anything: listening, or a deliberate move. */
  fun saysSomething(span: OpenSpan): Boolean = heard(span) || span.start in MOVE_STARTS

  /**
   * The reason a bare move sent already gives the book's next play: its own, but a Stay's as a
   * `jump`. That play may come hours later, and the server measures a Stay's slack from its span's
   * end (`staysWin`): a second `stay` then would beat what another device chose since the first one
   * (the phone's `carriedStart`).
   */
  fun carried(start: ListeningStart): ListeningStart =
    if (start == ListeningStart.STAY) ListeningStart.JUMP else start

  /**
   * A deliberate move nothing was heard after (a stop right behind a seek): all it says is the move,
   * like a move made while paused. Stamped ms after the span before it, its event can lose to that
   * span's when they are sent apart (`not_applied/older`), so the next span must carry the move too.
   */
  fun isBareMove(span: OpenSpan): Boolean = saysSomething(span) && !heard(span)

  /**
   * A move to where the place already is moves nothing (Previous at the book's start). A place that
   * is not one is not this: a NaN difference compares false; nor is a move to another file, whatever
   * the timeline says (the phone's book with unknown file lengths starts each at 0).
   */
  fun movesNowhere(from: SpanEnd?, to: SpanEnd?): Boolean {
    if (from == null || to == null) return false
    if (from.file != null && to.file != null && from.file != to.file) return false
    return abs(to.pos - from.pos) < ChapterNav.AT_START
  }
}

/** Where the open span is kept between launches (Files' `open-span.json`; a memory copy in tests). */
interface OpenSpanStore {
  fun load(): OpenSpan?

  fun save(span: OpenSpan?)
}

/**
 * The span lifecycle. One per app. Not thread-safe: the app calls it from the main thread only
 * (the Swift one is `@MainActor`).
 */
class SpanRecorder(
  private val store: OpenSpanStore,
  private val acks: AckStore,
  private val clock: () -> Instant = Instant::now,
  private val newId: () -> String = { UUID.randomUUID().toString().uppercase() },
  /** Takes closed events (the outbox's `append`; the caller sends after). */
  private val emit: (List<ListeningEvent>) -> Unit,
) {
  var span: OpenSpan? = null
    private set

  /** Why the next span begins; back to `resume` once a span takes it. */
  var nextStart: ListeningStart = ListeningStart.RESUME
    private set

  /** A finished book started again owes an `unfinish` before its first span. */
  private var unfinishDue = false

  /** The book whose `finish` was sent: one per end, until it plays again. */
  private var finishSent: BookRef? = null
  private var recovered = false

  /**
   * The move a kill cut short (`recover`): the launch's first span, when it is that book's,
   * nothing else was asked for (a resume) and it begins at this watch's own place (`loadsFromRow`),
   * begins with the move's reason.
   */
  private var recoveredMove: Pair<BookRef, ListeningStart>? = null

  /**
   * Close a span a kill left open (at its last stored values) into the outbox. Once per launch,
   * before the first span opens (every open runs it first). Returns that span (the place it
   * carries: `PlaceStore.recover`).
   */
  fun recover(): OpenSpan? {
    if (recovered) return null
    recovered = true
    val left = store.load() ?: return null
    // In this order, as in `close`: a kill between the two sends the span twice under its one id
    // (`duplicate`), the other way round it would lose the span.
    append(left)
    store.save(null)
    // A kill within `OPEN_SPAN_KEEP` of a move left the span the move opened, nothing heard: a
    // bare move, so the book's next span carries it, as after a pause (`close`).
    if (Spans.isBareMove(left)) recoveredMove = left.ref to Spans.carried(left.start)
    return left
  }

  /** The base a span goes on as it closes: the version acknowledged now, never below the one it opened on. */
  private fun baseAtClose(span: OpenSpan): Int? {
    val acked = acks.ackVersion(span.ref) ?: return span.baseVersion
    return max(span.baseVersion ?: 0, acked)
  }

  private fun append(span: OpenSpan) {
    if (!Spans.saysSomething(span)) return
    emit(listOf(Spans.event(span.copy(baseVersion = baseAtClose(span)))))
  }

  /**
   * The next span's reason and whether an `unfinish` goes first: an explicit 0 is a restart, an
   * explicit place a jump; a finished book started again is unfinished, then `restart`. Set per load
   * (the phone's `unfinishDue`): one owed by a book that never played is not carried to the next.
   */
  fun prepareStart(start: ListeningStart, unfinish: Boolean = false) {
    nextStart = start
    unfinishDue = unfinish
  }

  /**
   * `ref` loads at the server's row (`ResumePlan.tookRow`: another device's newer place, or the
   * server's when the watch has none), not where this watch left it. A move a kill cut short here
   * was not made from that place, so it is not the reason of the book's first span.
   */
  fun loadsFromRow(ref: BookRef) {
    recover()
    if (recoveredMove?.first == ref) recoveredMove = null
  }

  /** Playing began (or goes on after a cut) at `at`. */
  fun open(book: PlayingBook, at: SpanEnd, speed: Double) {
    recover()
    if (span?.ref == book.ref) return
    // Taken first: closing another book's span may leave that book's move in `nextStart`.
    var start = nextStart
    recoveredMove?.let { (ref, moved) ->
      recoveredMove = null
      if (ref == book.ref && start == ListeningStart.RESUME) start = moved
    }
    close(null)
    val now = clock()
    nextStart = ListeningStart.RESUME
    val base = acks.ackVersion(book.ref) ?: 0
    if (finishSent == book.ref) finishSent = null
    if (unfinishDue) {
      unfinishDue = false
      emit(listOf(finishEvent("unfinish", book.ref, now, base)))
    }
    val opened =
      OpenSpan(
        libraryId = book.ref.libraryId,
        path = book.ref.path,
        from = at,
        to = at,
        duration = book.audioDuration,
        speed = speed,
        startedAt = now,
        endedAt = now,
        start = start,
        baseVersion = base,
        id = newId(),
      )
    span = opened
    store.save(opened)
  }

  /**
   * Close the open span at `at` (null: where it was last seen) into the outbox. Returns it.
   * `stoppedAt`: when the audio stopped, for a stop noticed late; never after now, never before the
   * span's start.
   */
  fun close(at: SpanEnd?, stoppedAt: Instant? = null): OpenSpan? = close(at, stoppedAt, clearStore = true)

  /**
   * `clearStore` false: the caller opens the next span at once, and its store replaces this one in
   * one write (still after the event is kept), rather than a removal and a write.
   */
  private fun close(at: SpanEnd?, stoppedAt: Instant?, clearStore: Boolean): OpenSpan? {
    var closing = span
    if (closing == null) {
      // A Stay still waiting for its span (`standBy`, playing with none open) does not outlive the
      // play: one that ends first leaves the next a `jump` (`carried`).
      nextStart = Spans.carried(nextStart)
      return null
    }
    span = null
    if (at != null) closing = closing.copy(to = at)
    val now = clock()
    val stop = stoppedAt ?: now
    val ended = maxOf(closing.startedAt, minOf(now, stop))
    closing = closing.copy(endedAt = ended)
    append(closing)
    if (clearStore) store.save(null)
    // Like a paused move: the next play begins with the same reason (`isBareMove`, `carried`).
    if (Spans.isBareMove(closing)) nextStart = Spans.carried(closing.start)
    return closing
  }

  /** Cut the span (close it, a span opening where it ended for `start`) while playing. */
  fun cut(
    book: PlayingBook,
    at: SpanEnd?,
    playing: Boolean,
    speed: Double,
    start: ListeningStart = ListeningStart.CONTINUE,
  ) {
    // None open: nothing to cut, and a Stay waiting for its span goes on waiting (`close`).
    if (span == null) return
    val closed = close(at, null, clearStore = !playing) ?: return
    if (!playing) return
    // A bare move's reason is already there (`close`); a reason asked for (Stay) still wins.
    if (start != ListeningStart.CONTINUE || !Spans.isBareMove(closed)) nextStart = start
    open(book, closed.to, speed)
  }

  /**
   * The 15 s tick: cut while reachable, else only once the span has run `MAX_SPAN`. Playing with
   * none open (the play's own could not open one), one opens here. True when it cut.
   */
  fun tick(book: PlayingBook, at: SpanEnd?, playing: Boolean, reachable: Boolean, speed: Double): Boolean {
    val s = span
    if (s == null) {
      if (playing && at != null) open(book, at, speed)
      return false
    }
    if (reachable || clock().secondsSince(s.startedAt) >= Spans.MAX_SPAN) {
      cut(book, at, playing, speed)
      return true
    }
    return false
  }

  /**
   * One playing tick of the engine (Wear's PlayerEngine): the 15 s `tick` when `cutDue`, then the
   * 5 s `keep` when `keepDue`, unless the tick already stored the span (a cut or an open): the open
   * span is written once a tick. True when it cut (a span closed: the place is kept durably then).
   */
  fun playingTick(
    book: PlayingBook,
    at: SpanEnd?,
    speed: Double,
    keepDue: Boolean,
    cutDue: Boolean,
    reachable: Boolean,
  ): Boolean {
    val before = span
    val cut = cutDue && tick(book, at, true, reachable, speed)
    if (keepDue && span === before) keep(at)
    return cut
  }

  /**
   * Bring the open span up to `at` (never back: a remote move landing first ends the span at its
   * last place) and store it. Every `OPEN_SPAN_KEEP` while playing.
   */
  fun keep(at: SpanEnd?) {
    var s = span ?: return
    if (at != null && at.pos >= s.to.pos - 1) s = s.copy(to = at)
    s = s.copy(endedAt = clock())
    span = s
    store.save(s)
  }

  /**
   * A move of the place (a seek, a chapter, an offer's Jump) to `target`: the span ends where it was
   * (`from`, else where it was last seen), the next one begins at the target with the move's reason
   * (`moved_back` when behind, else `jump`). Paused, the move is sent at once as a span of its own
   * that moved nowhere, and the next play begins with the same reason.
   */
  fun move(
    book: PlayingBook,
    to: SpanEnd?,
    from: SpanEnd?,
    reason: ListeningStart? = null,
    playing: Boolean,
    speed: Double,
  ) {
    val before = from ?: span?.to
    val closed = close(before)
    val target = to ?: return
    val why =
      reason
        ?: if (before != null && target.pos < before.pos - 1) ListeningStart.MOVED_BACK else ListeningStart.JUMP
    if (closed != null && playing) {
      nextStart = why
      open(book, target, speed)
      return
    }
    sendStill(book, target, why, speed)
  }

  /**
   * A move made while paused, or a Stay (`start`, to `at`): sent at once as a span of its own that
   * moved nowhere, and the next span begins with the same reason (a Stay's as a `jump`: `carried`).
   */
  private fun sendStill(book: PlayingBook, at: SpanEnd, start: ListeningStart, speed: Double) {
    val now = clock()
    val still =
      OpenSpan(
        libraryId = book.ref.libraryId,
        path = book.ref.path,
        from = at,
        to = at,
        duration = book.audioDuration,
        speed = speed,
        startedAt = now,
        endedAt = now,
        start = start,
        baseVersion = acks.ackVersion(book.ref) ?: 0,
        id = newId(),
      )
    emit(listOf(Spans.event(still)))
    nextStart = Spans.carried(start)
  }

  /** The book's last span closed, then its `finish`, once. */
  fun finish(book: PlayingBook, at: SpanEnd?) {
    close(at)
    if (finishSent == book.ref) return
    finishSent = book.ref
    emit(listOf(finishEvent("finish", book.ref, clock(), acks.ackVersion(book.ref) ?: 0)))
  }

  /**
   * The listener answered an offer with Stay: this device's place stands, sent at once as a span
   * that moved nowhere (a paused move's) on the version the answer acknowledged: a `stay` on a
   * `listening_stay` server (`stay`), which the server applies over the other device's writes since
   * the offer, else a `jump`. Sent at once while playing too: a Stay that waited for the next cut
   * would let the other device's sync answers offer this place from before it meanwhile. Playing,
   * the span ends here and the next one begins here as a `jump` (`carried`), so nothing is heard
   * twice; paused, the next play begins as a `jump`: a `stay` sent at a play that may come much
   * later would beat what another device chose since. With no place to send (`at` null), the next
   * span is the Stay: the one cut now while playing, else the one that opens while this play goes
   * on (`close`); paused, the next play is a `jump`.
   */
  fun standBy(book: PlayingBook, at: SpanEnd?, playing: Boolean, speed: Double, stay: Boolean) {
    val start = if (stay) ListeningStart.STAY else ListeningStart.JUMP
    if (at != null) {
      // The open span (a playing one, or a stop noticed late) ends where the Stay is; playing, the
      // span opened next replaces it in the store (`cut`).
      val closed = close(at, null, clearStore = !playing)
      sendStill(book, at, start, speed)
      if (playing && closed != null) open(book, at, speed)
      return
    }
    if (playing) {
      if (span != null) cut(book, null, true, speed, start) else nextStart = start
      return
    }
    close(null)
    nextStart = Spans.carried(start)
  }

  private fun finishEvent(kind: String, ref: BookRef, at: Instant, base: Int) =
    FinishEvent(newId(), kind, ref.libraryId, ref.path, ISOTime.string(at), base)
}

/** The open span on disk (Files' `open-span.json`), what a kill leaves for the next launch to recover. */
class FileSpanStore(file: java.io.File) : OpenSpanStore {
  private val doc = JsonFile(file, OpenSpan.serializer(), durable = true)

  override fun load(): OpenSpan? = doc.read()

  override fun save(span: OpenSpan?) {
    doc.write(span)
  }
}
