// The watch's sleep timer, the phone's `sleep-timer.ts` rules cut down (no shake, no fade, no
// auto sleep): a duration timer counts down listening time only (frozen while paused, re-armed
// at full length after a pause past 20 minutes, ended after one past 2 hours), and an end of
// chapter timer stops at the next chapter end at least 30 s of wall clock ahead (else at the
// end of the book; with no book left, a 15 minute timer).
import Foundation

enum SleepMode: Codable, Equatable, Sendable {
  case minutes(Int)
  case endOfChapter
}

struct SleepTimer: Equatable, Sendable {
  static let RESET_AFTER_PAUSE: TimeInterval = 20 * 60
  static let ABANDON_AFTER_PAUSE: TimeInterval = 2 * 3600
  /// A chapter end nearer than this (wall clock) is not worth arming.
  static let MIN_CHAPTER_SECONDS: Double = 30
  static let FALLBACK_MINUTES = 15
  /// The choices on the watch.
  static let CHOICES: [SleepMode] = [.minutes(15), .minutes(30), .minutes(45), .minutes(60), .endOfChapter]

  /// How it was armed (a re-arm goes back to it).
  var mode: SleepMode
  /// Duration timer: wall seconds of listening left.
  var remaining: Double
  /// End of chapter timer: the whole-book position it stops at.
  var stopAt: Double?
  /// When playback paused with the timer frozen.
  var pausedAt: Date?

  /// Arm `mode` at `position`.
  static func arm(_ mode: SleepMode, position: Double, rate: Double, chapters: [Chapter], total: Double) -> SleepTimer {
    switch mode {
    case .minutes(let n):
      return SleepTimer(mode: mode, remaining: Double(max(1, n)) * 60, stopAt: nil, pausedAt: nil)
    case .endOfChapter:
      if let next = nextChapterEnd(chapters, position, rate: rate, minSeconds: MIN_CHAPTER_SECONDS) {
        return SleepTimer(mode: mode, remaining: 0, stopAt: next.endPosition, pausedAt: nil)
      }
      if total > 0, wallClockSeconds(total - position, rate: rate) > MIN_CHAPTER_SECONDS {
        return SleepTimer(mode: mode, remaining: 0, stopAt: total, pausedAt: nil)
      }
      return SleepTimer(mode: .minutes(FALLBACK_MINUTES), remaining: Double(FALLBACK_MINUTES) * 60, stopAt: nil,
                        pausedAt: nil)
    }
  }

  /// `wall` seconds were listened to (only playing time counts down).
  mutating func played(_ wall: Double) {
    guard stopAt == nil, wall.isFinite, wall > 0 else { return }
    remaining = max(0, remaining - wall)
  }

  /// Whether the timer has run out at `position`.
  func due(position: Double) -> Bool {
    if let stopAt { return position >= stopAt - 0.5 }
    return remaining <= 0
  }

  /// Wall seconds left at `position` and `rate` (what the button shows).
  func left(position: Double, rate: Double) -> Double {
    if let stopAt { return max(0, wallClockSeconds(stopAt - position, rate: rate)) }
    return remaining
  }

  mutating func paused(at now: Date) {
    if pausedAt == nil { pausedAt = now }
  }

  /// Playing again at `now`: the same timer, the duration timer re-armed after a long pause,
  /// or nil (ended) after an abandoned one.
  func resumed(at now: Date) -> SleepTimer? {
    var t = self
    t.pausedAt = nil
    guard let since = pausedAt.map({ now.timeIntervalSince($0) }), stopAt == nil, case .minutes(let n) = mode else {
      return t
    }
    if since > Self.ABANDON_AFTER_PAUSE { return nil }
    if since > Self.RESET_AFTER_PAUSE { t.remaining = Double(n) * 60 }
    return t
  }
}
