// Listening spans (Sync v2), a port of the span half of the phone's `src/playback/store.ts`
// and the event building in `listening-outbox.ts` (CROSS-REPO section 25, "Listening sync" in
// CONVENTIONS.md). The engine (WatchAudioEngine) tells the recorder what happens; the
// recorder turns it into `listen`, `finish` and `unfinish` events for the outbox.
//
// A span OPENS when playing starts; it is CUT (closed into an event, a `continue` span opening
// at once) every 15 s while the server is reachable, on a rate change and on going to the
// background; offline it stays open and is cut only after an hour (`MAX_SPAN`). It is
// CLOSED on a pause, a move (the next span opens with the move's reason), a stop, a book switch
// and the end (then one `finish`). The open span is stored every 5 s (`OPEN_SPAN_KEEP`) with its
// id fixed at open, and one a kill left is closed into the outbox at the next launch.
import Foundation

/// One end of a span: whole-book seconds, and the audio file (rel path) and seconds in it.
struct SpanEnd: Codable, Equatable, Sendable {
  var pos: Double
  var file: String?
  var filePos: Double?
}

/// The span being played.
struct OpenSpan: Codable, Equatable, Sendable {
  var libraryId: Int
  var path: String
  var from: SpanEnd
  var to: SpanEnd
  /// The audio's length (`Timeline.audio`, 0 = unknown).
  var duration: Double
  var speed: Double
  var startedAt: Date
  var endedAt: Date
  var start: ListeningStart
  /// The version acknowledged when it opened.
  var baseVersion: Int?
  /// Its event's id, chosen at open: a span closed twice is one event (`duplicate`).
  var id: String

  var ref: BookRef { BookRef(libraryId: libraryId, path: path) }
}

/// The book a span belongs to and the audio's length.
struct PlayingBook: Equatable, Sendable {
  var ref: BookRef
  /// `Timeline.audio`.
  var audioDuration: Double
}

enum Spans {
  /// A span shorter than this that moved nowhere says nothing.
  static let EMPTY_SPAN: TimeInterval = 1
  /// The longest wall time an event may claim (the server refuses 24 h).
  static let MAX_EVENT_SPAN: TimeInterval = 23 * 3600
  /// The longest a span stays open before it is cut, online or offline.
  static let MAX_SPAN: TimeInterval = 3600
  /// How often a playing span is cut while the server is reachable.
  static let CUT_INTERVAL: TimeInterval = 15
  /// How often the open span is stored while playing.
  static let OPEN_SPAN_KEEP: TimeInterval = 5

  /// A span's start as its event claims it: its own, unless it ran longer than
  /// `MAX_EVENT_SPAN` (timers that stood still); then as long before the end as the audio it
  /// covered takes to play (at least a second, at most the bound).
  static func claimedStart(_ span: OpenSpan, endedAt: Date) -> Date {
    guard endedAt.timeIntervalSince(span.startedAt) > MAX_EVENT_SPAN else { return span.startedAt }
    let played = wallClockSeconds(abs(span.to.pos - span.from.pos), rate: span.speed)
    let wall = min(MAX_EVENT_SPAN, max(1, played.isFinite ? played : 0))
    return endedAt.addingTimeInterval(-wall)
  }

  /// A span as its `listen` event. Each end's file pair goes only whole; speed 1, an unknown
  /// length and an unknown base are left out.
  static func event(_ span: OpenSpan) -> SpanEvent {
    let endedAt = span.endedAt < span.startedAt ? span.startedAt : span.endedAt
    var e = SpanEvent(
      id: span.id, libraryId: span.libraryId, path: span.path,
      fromPos: nonNegative(span.from.pos), toPos: nonNegative(span.to.pos),
      startedAt: ISOTime.string(claimedStart(span, endedAt: endedAt)),
      endedAt: ISOTime.string(endedAt), start: span.start)
    if let f = span.from.file, let p = span.from.filePos, p.isFinite {
      e.fromFile = f
      e.fromFilePos = nonNegative(p)
    }
    if let f = span.to.file, let p = span.to.filePos, p.isFinite {
      e.toFile = f
      e.toFilePos = nonNegative(p)
    }
    if span.duration > 0 { e.duration = span.duration }
    if span.speed > 0 && span.speed <= 4 && span.speed != 1 { e.playbackSpeed = span.speed }
    e.baseVersion = span.baseVersion
    return e
  }

  /// `max(0, x)` that keeps a NaN a NaN (Swift's `max(0, .nan)` is 0, which would send a
  /// place that is not one as the start of the book): `isFinite` then keeps it out.
  static func nonNegative(_ x: Double) -> Double { x.isNaN ? x : max(0, x) }

  /// Whether a span carries anything: listening, or a deliberate move.
  static func saysSomething(_ span: OpenSpan) -> Bool {
    if span.endedAt.timeIntervalSince(span.startedAt) >= EMPTY_SPAN || abs(span.to.pos - span.from.pos) >= 1 {
      return true
    }
    return span.start == .jump || span.start == .movedBack || span.start == .restart
  }
}

/// Where the open span is kept between launches (Files.swift's `open-span.json`; a memory
/// copy in the tests).
protocol OpenSpanStore: AnyObject {
  func load() -> OpenSpan?
  func save(_ span: OpenSpan?)
}

/// The span lifecycle. One per app; used on the main actor.
@MainActor
final class SpanRecorder {
  private let store: OpenSpanStore
  private let acks: AckStore
  private let clock: () -> Date
  private let newId: () -> String
  /// Takes closed events (the outbox's `append`; the caller sends after).
  private let emit: ([ListeningEvent]) -> Void

  private(set) var span: OpenSpan?
  /// Why the next span begins; back to `resume` once a span takes it.
  private(set) var nextStart: ListeningStart = .resume
  /// A finished book started again owes an `unfinish` before its first span.
  private var unfinishDue = false
  /// The book whose `finish` was sent: one per end, until it plays again.
  private var finishSent: BookRef?
  private var recovered = false

  init(store: OpenSpanStore, acks: AckStore, clock: @escaping () -> Date = Date.init,
       newId: @escaping () -> String = { UUID().uuidString },
       emit: @escaping ([ListeningEvent]) -> Void)
  {
    self.store = store
    self.acks = acks
    self.clock = clock
    self.newId = newId
    self.emit = emit
  }

  /// Close a span a kill left open (at its last stored values) into the outbox. Once per
  /// launch, before the first span opens (every open runs it first).
  func recover() {
    guard !recovered else { return }
    recovered = true
    if let left = store.load() {
      // In this order, as in `close`: a kill between the two sends the span twice under its one
      // id (`duplicate`), the other way round it would lose the span.
      append(left)
      store.save(nil)
    }
  }

  /// The base a span goes on as it closes: the version acknowledged now, never below the one
  /// it opened on.
  private func baseAtClose(_ span: OpenSpan) -> Int? {
    guard let acked = acks.ackVersion(span.ref) else { return span.baseVersion }
    return max(span.baseVersion ?? 0, acked)
  }

  private func append(_ span: OpenSpan) {
    guard Spans.saysSomething(span) else { return }
    var closing = span
    closing.baseVersion = baseAtClose(span)
    emit([.listen(Spans.event(closing))])
  }

  /// The next span's reason and whether an `unfinish` goes first: an explicit 0 is a restart,
  /// an explicit place a jump; a finished book started again is unfinished, then `restart`.
  /// Set per load (the phone's `unfinishDue`): one owed by a book that never played is not
  /// carried to the next.
  func prepareStart(_ start: ListeningStart, unfinish: Bool = false) {
    nextStart = start
    unfinishDue = unfinish
  }

  /// Playing began (or goes on after a cut) at `at`.
  func open(_ book: PlayingBook, at: SpanEnd, speed: Double) {
    recover()
    if let s = span {
      if s.ref == book.ref { return }
      close(at: nil)
    }
    let now = clock()
    let start = nextStart
    nextStart = .resume
    let base = acks.ackVersion(book.ref) ?? 0
    if finishSent == book.ref { finishSent = nil }
    if unfinishDue {
      unfinishDue = false
      emit([.finish(finishEvent("unfinish", book.ref, at: now, base: base))])
    }
    let opened = OpenSpan(
      libraryId: book.ref.libraryId, path: book.ref.path, from: at, to: at,
      duration: book.audioDuration, speed: speed, startedAt: now, endedAt: now,
      start: start, baseVersion: base, id: newId())
    span = opened
    store.save(opened)
  }

  /// Close the open span at `at` (nil: where it was last seen) into the outbox. Returns it.
  /// `stoppedAt`: when the audio stopped, for a stop noticed late (the system paused the
  /// player while the app was suspended); never after now, never before the span's start.
  @discardableResult
  func close(at: SpanEnd?, stoppedAt: Date? = nil) -> OpenSpan? {
    guard var closing = span else { return nil }
    span = nil
    if let at { closing.to = at }
    let now = clock()
    closing.endedAt = max(closing.startedAt, min(now, stoppedAt ?? now))
    append(closing)
    store.save(nil)
    return closing
  }

  /// Cut the span (close it, a span opening where it ended for `start`) while playing.
  func cut(_ book: PlayingBook, at: SpanEnd?, playing: Bool, speed: Double, start: ListeningStart = .continue) {
    guard let closed = close(at: at), playing else { return }
    nextStart = start
    open(book, at: closed.to, speed: speed)
  }

  /// The 15 s tick: cut while reachable, else only once the span has run `MAX_SPAN`. Playing
  /// with none open (the play's own could not open one), one opens here.
  func tick(_ book: PlayingBook, at: SpanEnd?, playing: Bool, reachable: Bool, speed: Double) {
    guard let s = span else {
      if playing, let at { open(book, at: at, speed: speed) }
      return
    }
    if reachable || clock().timeIntervalSince(s.startedAt) >= Spans.MAX_SPAN {
      cut(book, at: at, playing: playing, speed: speed)
    }
  }

  /// Bring the open span up to `at` (never back: a remote move landing first ends the span at
  /// its last place) and store it. Every `OPEN_SPAN_KEEP` while playing.
  func keep(at: SpanEnd?) {
    guard var s = span else { return }
    if let at, at.pos >= s.to.pos - 1 { s.to = at }
    s.endedAt = clock()
    span = s
    store.save(s)
  }

  /// A move of the place (a seek, a chapter, an offer's Jump) to `target`: the span ends where
  /// it was (`from`, else where it was last seen), the next one begins at the target with the
  /// move's reason (`moved_back` when behind, else `jump`). Paused, the move is sent at once as
  /// a span of its own that moved nowhere, and the next play begins with the same reason.
  func move(_ book: PlayingBook, to target: SpanEnd?, from: SpanEnd?, reason: ListeningStart? = nil,
            playing: Bool, speed: Double)
  {
    let before = from ?? span?.to
    let closed = close(at: before)
    guard let target else { return }
    let why = reason ?? (before.map { target.pos < $0.pos - 1 } == true ? .movedBack : .jump)
    if closed != nil && playing {
      nextStart = why
      open(book, at: target, speed: speed)
      return
    }
    let now = clock()
    let still = OpenSpan(
      libraryId: book.ref.libraryId, path: book.ref.path, from: target, to: target,
      duration: book.audioDuration, speed: speed, startedAt: now, endedAt: now, start: why,
      baseVersion: acks.ackVersion(book.ref) ?? 0, id: newId())
    emit([.listen(Spans.event(still))])
    nextStart = why
  }

  /// The book's last span closed, then its `finish`, once.
  func finish(_ book: PlayingBook, at: SpanEnd?) {
    close(at: at)
    if finishSent == book.ref { return }
    finishSent = book.ref
    emit([.finish(finishEvent("finish", book.ref, at: clock(), base: acks.ackVersion(book.ref) ?? 0))])
  }

  /// The listener answered an offer with Stay: this device's place stands, so its next span is
  /// a deliberate move (`jump`), which the server applies over the other place.
  func standBy(_ book: PlayingBook, at: SpanEnd?, playing: Bool, speed: Double) {
    nextStart = .jump
    if span != nil && playing { cut(book, at: at, playing: playing, speed: speed, start: .jump) }
  }

  private func finishEvent(_ kind: String, _ ref: BookRef, at: Date, base: Int) -> FinishEvent {
    FinishEvent(id: newId(), kind: kind, libraryId: ref.libraryId, path: ref.path, at: ISOTime.string(at), baseVersion: base)
  }
}
