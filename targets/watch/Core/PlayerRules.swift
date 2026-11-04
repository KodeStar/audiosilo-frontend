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

  /// A speed as it reads on a button: "1x", "1.25x".
  static func label(_ rate: Double) -> String {
    let r = (clamp(rate) * 100).rounded() / 100
    return r == r.rounded() ? "\(Int(r))x" : "\(r)x"
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

  /// Wall-clock seconds left in the book at `rate`.
  static func timeLeft(position: Double, total: Double, rate: Double) -> Double {
    wallClockSeconds(max(0, total - position), rate: rate)
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
  static func index(_ chapters: [Chapter], _ position: Double) -> Int? {
    guard !chapters.isEmpty else { return nil }
    var current = 0
    for (i, ch) in chapters.enumerated() {
      if position + AT_START >= ch.bookOffset { current = i } else { break }
    }
    return current
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
}

/// What Now Playing shows: the chapter's title and times within it (the whole book's without chapters).
struct NowPlayingTimes: Equatable {
  var chapterIndex: Int?
  var title: String
  var elapsed: Double
  var duration: Double

  /// `fallbackTitle` for a chapter without a title (synthetic ones: "Part 2").
  static func of(chapters: [Chapter], position: Double, total: Double, bookTitle: String) -> NowPlayingTimes {
    guard let i = ChapterNav.index(chapters, position) else {
      return NowPlayingTimes(chapterIndex: nil, title: bookTitle, elapsed: max(0, position), duration: max(0, total))
    }
    let ch = chapters[i]
    // A chapter runs to the next one's start; the last to its own end, else the book's.
    let end: Double
    if i + 1 < chapters.count {
      end = chapters[i + 1].bookOffset
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
}

extension LocalPlace {
  init(_ end: SpanEnd, at: Date) {
    self.init(position: end.pos, file: end.file, filePos: end.filePos, at: at)
  }
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
  /// Pull before play (CROSS-REPO section 25): the watch's own place unless the server holds a
  /// newer one from another device at a version this watch has not seen; the server's when the
  /// watch has none. A place at the end (or a finished row taken) starts again from 0 with an
  /// `unfinish` and a `restart` span. A place the watch keeps over the row may still be offered
  /// (`Offers.offerOf`).
  static func plan(local: LocalPlace?, row: ProgressRow?, deviceId: String, ackVersion: Int?, total: Double)
    -> ResumePlan
  {
    var take: ResumePlan
    if let row, shouldTake(row, local: local, deviceId: deviceId, ackVersion: ackVersion) {
      take = ResumePlan(position: row.position, file: nil, filePos: nil, start: .resume, unfinish: false, tookRow: true)
      if row.finished { return restart(tookRow: true) }
    } else if let local {
      take = ResumePlan(position: local.position, file: local.file, filePos: local.filePos, start: .resume,
                        unfinish: false, tookRow: false)
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

  private static func shouldTake(_ row: ProgressRow, local: LocalPlace?, deviceId: String, ackVersion: Int?) -> Bool {
    guard let local else { return true }
    guard let device = row.deviceId, !device.isEmpty, device != deviceId else { return false }
    guard row.version > (ackVersion ?? 0), let updated = ISOTime.parse(row.updatedAt) else { return false }
    return updated > local.at
  }

  private static func restart(tookRow: Bool) -> ResumePlan {
    ResumePlan(position: 0, file: nil, filePos: nil, start: .restart, unfinish: true, tookRow: tookRow)
  }
}

/// The places this watch played to, per book (`places.json`).
@MainActor
final class PlaceStore {
  private let file: JSONFile<[String: LocalPlace]>?
  private var places: [String: LocalPlace]

  /// `url` nil keeps them in memory (tests).
  init(url: URL?) {
    file = url.map { JSONFile(url: $0) }
    places = file?.read() ?? [:]
  }

  func place(_ ref: BookRef) -> LocalPlace? { places[ref.key] }

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
