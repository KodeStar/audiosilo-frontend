// The player's pure rules: speed, skips, chapter moves, the Now Playing times and
// where a book resumes. The engine (Playback/WatchAudioEngine.swift) only carries them out, so
// the positions it plays and reports are the ones tested here. Every position is whole-book
// seconds (the Timeline's), never a file's.
import Foundation

enum PlaybackSpeed {
  /// The product's range and presets (the phone's `rate.ts` and `speed-model.ts`).
  static let MIN: Double = 0.5
  static let MAX: Double = 2
  static let PRESETS: [Double] = [0.8, 1, 1.1, 1.2, 1.25, 1.3, 1.5, 2]

  /// A speed inside the range; anything that is not a number is 1.
  static func clamp(_ rate: Double) -> Double {
    guard rate.isFinite, rate > 0 else { return 1 }
    return min(MAX, max(MIN, rate))
  }

  /// The speed a book plays at when it loads: its own saved speed when it has one, else the
  /// listener's default, in the range (the phone's `bookSpeed`: a 3x saved elsewhere plays at 2x).
  static func book(saved: Double?, defaultRate: Double) -> Double {
    if let saved, saved > 0 { return clamp(saved) }
    return clamp(defaultRate > 0 ? defaultRate : 1)
  }

  /// A speed as it reads on a button: "1x", "1.25x".
  static func label(_ rate: Double) -> String { number(rate) + "x" }

  /// A speed as a sentence says it, the phone's `formatSpeed`: "2×", "1.25×".
  static func sentenceLabel(_ rate: Double) -> String { number(rate) + "×" }

  /// Whether a speed reads as normal speed (the phone's `isNormalSpeed`): two decimals, as shown.
  static func isNormal(_ rate: Double) -> Bool { (clamp(rate) * 100).rounded() == 100 }

  private static func number(_ rate: Double) -> String {
    let r = (clamp(rate) * 100).rounded() / 100
    return r == r.rounded() ? "\(Int(r))" : "\(r)"
  }
}

enum Skips {
  /// The phone's defaults (`skipBackward` 15, `skipForward` 30).
  static let BACK: Double = 15
  static let FORWARD: Double = 30

  /// Where a skip by `delta` lands: never before the start, never past the end (a known end).
  static func target(position: Double, by delta: Double, total: Double) -> Double {
    let p = (position.isFinite ? position : 0) + delta
    if total > 0 { return min(total, max(0, p)) }
    return max(0, p)
  }

  /// Wall-clock seconds left to `total` at `rate`.
  static func timeLeft(position: Double, total: Double, rate: Double) -> Double {
    wallClockSeconds(max(0, total - position), rate: rate)
  }

  /// The two figures beside the bar, the phone's seek bar: both audio time, whatever the speed, in
  /// whole seconds that add up to the length (each rounded alone, they can read a second short).
  static func figures(position: Double, length: Double) -> (elapsed: Double, left: Double) {
    let whole = length.rounded()
    let elapsed = min(whole, (position.isFinite ? max(0, position) : 0).rounded(.down))
    return (elapsed, whole - elapsed)
  }

  /// The line under the figures: "2m left at 2×", the phone's `formatTimeLeft`. Nil at normal speed,
  /// where the figures already say it, and with nothing left.
  static func wallClockLine(position: Double, total: Double, rate: Double) -> String? {
    guard !PlaybackSpeed.isNormal(rate),
      let time = compactDuration(timeLeft(position: position, total: total, rate: rate))
    else { return nil }
    return "\(time) left at \(PlaybackSpeed.sentenceLabel(rate))"
  }

  /// "12h 30m", "45m", "30s", nil for nothing: the phone's `formatDuration`.
  static func compactDuration(_ seconds: Double) -> String? {
    guard seconds.isFinite, seconds > 0 else { return nil }
    let total = Int(seconds.rounded())
    let h = total / 3600, m = (total % 3600) / 60
    if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
    return m > 0 ? "\(m)m" : "\(total)s"
  }

  /// Whether a place is the book's end (within `FINISHED_TOLERANCE`).
  static func atEnd(position: Double, total: Double) -> Bool {
    total > 0 && position >= total - FINISHED_TOLERANCE
  }
}

enum ChapterNav {
  /// Previous restarts the chapter when more than this far into it (the phone's lock screen rule).
  static let RESTART_THRESHOLD: Double = 3
  /// Next skips a start this close ahead, so a press right after a move doesn't land on the same
  /// start (the phone's `nextSegmentStart`).
  static let NEXT_SLACK: Double = 1.5
  /// A place this little short of a start is at it: a seek lands a hair before the start it was
  /// asked for (CMTime rounds down), and still reads as that chapter (the phone's 0.01).
  static let AT_START: Double = 0.01

  /// The index of the chapter at `position` (the first before every chapter); nil with none.
  /// In `file` (the playing one) when it has a chapter there; equal starts go by `winsTie`.
  static func index(_ chapters: [Chapter], _ position: Double, file: String? = nil) -> Int? {
    guard !chapters.isEmpty else { return nil }
    var current: Int?
    var own: Int?
    func takes(_ ch: Chapter, over at: Int?) -> Bool {
      guard let at else { return true }
      let best = chapters[at]
      return ch.bookOffset > best.bookOffset || (ch.bookOffset == best.bookOffset && winsTie(ch, best))
    }
    for (i, ch) in chapters.enumerated() where ch.bookOffset <= position + AT_START {
      if takes(ch, over: current) { current = i }
      if ch.filePath == file && takes(ch, over: own) { own = i }
    }
    return own ?? current ?? 0
  }

  /// Markers at one start (the phone's `tiedMarkerWins`): the first in book file order (an
  /// unknown file after every known one); within one file a marker with length over one of
  /// none (a duplicated marker before the real chapter); else list order.
  static func winsTie(_ a: Chapter, _ b: Chapter) -> Bool {
    let fa = a.fileIndex < 0 ? Int.max : a.fileIndex
    let fb = b.fileIndex < 0 ? Int.max : b.fileIndex
    return fa < fb || (fa == fb && a.end - a.start > 0 && !(b.end - b.start > 0))
  }

  /// Previous chapter: this one's start when more than 3 s in, else the one before's (0 before
  /// the first; the phone's `previousSegmentStart`).
  static func previous(_ chapters: [Chapter], _ position: Double) -> Double? {
    guard !chapters.isEmpty else { return nil }
    let current = chapters.last { $0.bookOffset <= position + AT_START }?.bookOffset ?? 0
    if position - current > RESTART_THRESHOLD { return current }
    return chapters.last { $0.bookOffset < current - AT_START }?.bookOffset ?? 0
  }

  /// A chapter's title, "Part 2" for one without (synthetic ones).
  static func title(_ ch: Chapter, index i: Int) -> String {
    ch.title.trimmingCharacters(in: .whitespaces).isEmpty ? "Part \(i + 1)" : ch.title
  }

  /// Next chapter's start: the first more than `NEXT_SLACK` ahead, nil at the last one.
  static func next(_ chapters: [Chapter], _ position: Double) -> Double? {
    chapters.first { $0.bookOffset > position + NEXT_SLACK }?.bookOffset
  }

  /// Previous (-1) or next (+1) from the playing place (`at`: the file and seconds into it), nil
  /// with no chapters or past the last. By whole-book seconds (`previous`, `next`) unless files
  /// share a start (a file of unknown length: its seconds run past the next file's start, so
  /// they do not order the chapters); then in file order, as the phone's `stepInFileOrder`: next
  /// is the first chapter `NEXT_SLACK` ahead, previous restarts the current chapter (one begun in
  /// an earlier file always) and within its first 3 s goes to the one before, else the book's start.
  static func step(_ t: Timeline, _ dir: Int, position: Double,
                   at: (index: Int, positionInTrack: Double)) -> ChapterStop? {
    let o = t.offsets
    guard !t.chapters.isEmpty else { return nil }
    guard o.indices.contains(at.index), o.indices.dropFirst().contains(where: { o[$0] == o[$0 - 1] }) else {
      return (dir < 0 ? previous(t.chapters, position) : next(t.chapters, position)).map { ChapterStop(position: $0) }
    }
    let stops = t.chapters.filter { o.indices.contains($0.fileIndex) }
      .sorted { ($0.fileIndex, $0.start) < ($1.fileIndex, $1.start) }
    func after(_ c: Chapter, _ index: Int, _ pos: Double) -> Bool {
      c.fileIndex > index || (c.fileIndex == index && c.start > pos)
    }
    func stop(_ c: Chapter) -> ChapterStop { ChapterStop(position: c.bookOffset, file: c.filePath, filePos: c.start) }
    if dir > 0 { return stops.first { after($0, at.index, at.positionInTrack + NEXT_SLACK) }.map(stop) }
    let bookStart = ChapterStop(position: 0, file: t.files[0].path, filePos: 0)
    guard let current = stops.last(where: { !after($0, at.index, at.positionInTrack + AT_START) }) else {
      return bookStart
    }
    if current.fileIndex < at.index || at.positionInTrack - current.start > RESTART_THRESHOLD { return stop(current) }
    return stops.last { after(current, $0.fileIndex, $0.start + AT_START) }.map(stop) ?? bookStart
  }
}

/// Where a chapter move lands: whole-book seconds and, among files sharing a start, the file and
/// seconds into it (nil: the place goes by the whole-book seconds).
struct ChapterStop: Equatable {
  var position: Double
  var file: String?
  var filePos: Double?
}

/// What Now Playing shows: the chapter's title and times within it (the whole book's without chapters).
struct NowPlayingTimes: Equatable {
  var chapterIndex: Int?
  var title: String
  var elapsed: Double
  var duration: Double

  /// The chapter at `position` and the times within it (`ChapterNav.title` names one without a
  /// title), else the whole book.
  static func of(chapters: [Chapter], position: Double, total: Double, bookTitle: String, file: String? = nil) -> NowPlayingTimes {
    guard let i = ChapterNav.index(chapters, position, file: file) else {
      return NowPlayingTimes(chapterIndex: nil, title: bookTitle, elapsed: max(0, position), duration: max(0, total))
    }
    let ch = chapters[i]
    // A chapter runs to the next one's start; the last to its own end, else the book's.
    let end: Double
    if let next = chapters.dropFirst(i + 1).first(where: { $0.bookOffset > ch.bookOffset }) {
      end = next.bookOffset
    } else {
      end = chapterEndPosition(ch) > ch.bookOffset ? chapterEndPosition(ch) : total
    }
    let duration = max(0, end - ch.bookOffset)
    let into = max(0, position - ch.bookOffset)
    let elapsed = duration > 0 ? min(into, duration) : into
    return NowPlayingTimes(chapterIndex: i, title: ChapterNav.title(ch, index: i), elapsed: elapsed, duration: duration)
  }
}

/// This watch's own last place in a book, kept as it plays (places.json).
struct LocalPlace: Codable, Equatable, Sendable {
  var position: Double
  var file: String?
  var filePos: Double?
  var at: Date
  /// The speed the book plays at here (a book keeps its own, as on the phone).
  var speed: Double?
}

extension LocalPlace {
  init(_ end: SpanEnd, at: Date, speed: Double? = nil) {
    self.init(position: end.pos, file: end.file, filePos: end.filePos, at: at, speed: speed)
  }

  static func newer(_ kept: LocalPlace, _ cut: LocalPlace) -> LocalPlace {
    cut.at > kept.at ? cut : kept
  }

  /// A cut this watch sent, dated on the watch's clock so a later local seek still wins.
  static func fromRow(_ row: ProgressRow, clockSkewMs: Double) -> LocalPlace? {
    ISOTime.parse(row.updatedAt).map {
      LocalPlace(position: row.position, at: $0.addingTimeInterval(-clockSkewMs.rounded(.towardZero) / 1000),
                 speed: row.playbackSpeed)
    }
  }
}

extension SpanEvent {
  /// A play's span that never moved carries the loaded place, not one this watch heard.
  var heardPlace: Bool { start != .resume || abs(toPos - fromPos) >= Spans.EMPTY_SPAN }
}

/// Where a book starts when it is loaded, and how its first span begins.
struct ResumePlan: Equatable {
  var position: Double
  var file: String?
  var filePos: Double?
  var start: ListeningStart
  /// A finished book started again: an `unfinish` goes before its first span.
  var unfinish: Bool
  /// The server row was taken (resuming from it, or moving to another device's newer place):
  /// its version is acknowledged.
  var tookRow: Bool
}

enum Resume {
  /// Pull before play (CROSS-REPO section 25): take a newer place from another device at an unseen
  /// version, or this watch's newer cut at or above its acknowledged version. Take the server's
  /// place when the watch has none. A place at the end (or a finished row taken) starts again
  /// from 0 with an `unfinish` and a `restart` span. A place the watch keeps over the row may still be offered
  /// (`Offers.offerOf`). `waiting`: the book has events still to send (this watch's own unfinish
  /// may be among them, so the server's finished row is not news).
  static func plan(local: LocalPlace?, row: ProgressRow?, deviceId: String, ackVersion: Int?, total: Double,
                   waiting: Bool = false, clockSkewMs: Double = 0) -> ResumePlan
  {
    var take: ResumePlan
    if let row, shouldTake(row, local: local, deviceId: deviceId, ackVersion: ackVersion, clockSkewMs: clockSkewMs)
      || finishWins(row, local: local, ackVersion: ackVersion, waiting: waiting, clockSkewMs: clockSkewMs)
    {
      take = ResumePlan(position: row.position, file: nil, filePos: nil, start: .resume, unfinish: false, tookRow: true)
      if row.finished { return restart(tookRow: true) }
    } else if let local {
      take = ResumePlan(position: local.position, file: local.file, filePos: local.filePos, start: .resume,
                        unfinish: false, tookRow: false)
      // Finished on the server, this place newer and nothing of this watch's on its way (moved
      // back into the book after its end, not played then). A listen never unfinishes, so the
      // first span goes after an `unfinish`, as a deliberate move.
      if row?.finished == true, !waiting {
        take.unfinish = true
        take.start = .jump
      }
    } else {
      take = ResumePlan(position: 0, file: nil, filePos: nil, start: .resume, unfinish: false, tookRow: false)
    }
    if !take.position.isFinite || take.position < 0 {
      take.position = 0
      take.file = nil
      take.filePos = nil
    }
    if Skips.atEnd(position: take.position, total: total) { return restart(tookRow: take.tookRow) }
    return take
  }

  private static func shouldTake(_ row: ProgressRow, local: LocalPlace?, deviceId: String, ackVersion: Int?,
                                 clockSkewMs: Double) -> Bool {
    guard let local else { return true }
    guard let device = row.deviceId, !device.isEmpty else { return false }
    if device == deviceId {
      // A finished row follows finishWins. Compare the server's cut on the watch's clock: its ack
      // can survive a failed place write, so the ack alone says nothing about which place survived.
      guard let sent = LocalPlace.fromRow(row, clockSkewMs: clockSkewMs) else { return false }
      return !row.finished && row.position != local.position && row.version >= (ackVersion ?? 0) && sent.at > local.at
    }
    guard let updated = ISOTime.parse(row.updatedAt) else { return false }
    return row.version > (ackVersion ?? 0) && onWatchClock(updated, clockSkewMs) > local.at
  }

  /// The phone's `serverFinishWins`: the server's finished row beats a newer place here when the
  /// finish is newer than that place, or at a version this watch never acknowledged (another
  /// device's finish, which the place here only did not know of). A finish is a state the server
  /// orders on its own, so the book starts again rather than resuming the old place. The finish
  /// is compared on the watch's clock, as the phone compares it on its own (`serverTimeOf`).
  private static func finishWins(_ row: ProgressRow, local: LocalPlace?, ackVersion: Int?, waiting: Bool,
                                 clockSkewMs: Double) -> Bool {
    guard let local, !waiting, row.finished else { return false }
    if let finished = row.finishedAt.flatMap(ISOTime.parse), onWatchClock(finished, clockSkewMs) > local.at {
      return true
    }
    return row.version > (ackVersion ?? 0)
  }

  /// A server time on the watch's clock (`LocalPlace.fromRow`'s shift).
  private static func onWatchClock(_ serverTime: Date, _ clockSkewMs: Double) -> Date {
    serverTime.addingTimeInterval(-clockSkewMs.rounded(.towardZero) / 1000)
  }

  /// The speed saved for the book `plan` resumes: the row's when it was taken, else this watch's
  /// own, else the row's; nil for a book with none (it plays at the listener's default).
  static func savedSpeed(_ plan: ResumePlan, local: LocalPlace?, row: ProgressRow?) -> Double? {
    plan.tookRow ? row?.playbackSpeed : (local?.speed ?? row?.playbackSpeed)
  }

  private static func restart(tookRow: Bool) -> ResumePlan {
    ResumePlan(position: 0, file: nil, filePos: nil, start: .restart, unfinish: true, tookRow: tookRow)
  }
}

/// The places this watch played to, per book (`places.json`).
@MainActor
final class PlaceStore {
  private let file: JSONFile<[String: LocalPlace]>?
  private var places: [String: LocalPlace] = [:]

  /// `url` nil keeps them in memory (tests).
  init(url: URL?) {
    file = url.map { JSONFile(url: $0) }
    reload()
  }

  /// Read the file: at launch, and again after a launch before the watch's first unlock read none
  /// (nothing has changed it since: no book plays until then).
  func reload() {
    if let kept = file?.read() { places = kept }
  }

  func place(_ ref: BookRef) -> LocalPlace? { places[ref.key] }

  /// A cut can reach the outbox before its place lands. A later local move or speed change stands.
  /// Wear's `recoverCuts`, given each book's last heard cut already.
  func recoverCuts(_ cuts: [String: LocalPlace]) {
    let restored = places.merging(cuts, uniquingKeysWith: LocalPlace.newer)
    guard restored != places else { return }
    places = restored
    file?.write(places)
  }

  func set(_ ref: BookRef, _ place: LocalPlace) {
    guard place.position.isFinite else { return }
    places[ref.key] = place
    file?.write(places)
  }

  func remove(_ ref: BookRef) {
    places[ref.key] = nil
    file?.write(places)
  }

  func clear() {
    places = [:]
    file?.write(nil)
  }
}
