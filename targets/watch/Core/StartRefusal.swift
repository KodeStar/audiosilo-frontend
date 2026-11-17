// A play whose audio never moved: the player stopped before its first tick. That is often the
// system pausing it, not a failed start: Siri, a call or an alert (an interruption whose `began`
// can arrive up to INTERRUPTION_SLACK after the pause) or headphones that went away (a route change
// whose old device is gone). So "could not start" waits out the slack, and either of those within
// it says the pause was the system's: nothing is shown. The engine carries this out
// (WatchAudioEngine `controlChanged`, `interrupted`, `routeChanged`): its timer is what waits, so
// the message never depends on a clock read. The stamps are a monotonic clock's (`Stamp`), never
// the wall clock's (fe#320): a clock set forward within the slack would read a Siri pause as a
// failed start, one set back would take a late `began` for that pause.
import Foundation

struct StartRefusal {
  /// When something happened, by a clock the user's or the network's time never moves.
  typealias Stamp = ContinuousClock.Instant

  /// How long after the system paused the player its interruption's `began` can still arrive.
  static let INTERRUPTION_SLACK: TimeInterval = 2

  /// When the start was refused, while its message waits.
  private(set) var refusedAt: Stamp?

  /// The player stopped before its audio moved: the message waits for the slack.
  mutating func refused(at now: Stamp) { refusedAt = now }

  /// Whether `now` is still within the slack of a pause at `pausedAt`.
  static func withinSlack(of pausedAt: Stamp?, at now: Stamp) -> Bool {
    pausedAt.map { $0.duration(to: now) < .seconds(INTERRUPTION_SLACK) } ?? false
  }

  /// An interruption began, or the route's old device went: a refusal within the slack was the
  /// system's pause, so it says nothing.
  mutating func explained(at now: Stamp) {
    if Self.withinSlack(of: refusedAt, at: now) { refusedAt = nil }
  }

  /// A new play, a load, a stop or a failure with its own message: an earlier refusal says nothing more.
  mutating func reset() { refusedAt = nil }

  /// The message of the refusal at `refusal`, asked for when its slack has passed (the engine's
  /// timer) and given once. Nil when that refusal was explained or reset; a newer one waits its own
  /// slack.
  mutating func message(for refusal: Stamp) -> String? {
    guard refusedAt == refusal else { return nil }
    refusedAt = nil
    return PlaybackFailure.audioStart.message
  }
}

/// Whether an interruption's end plays the book again (WatchAudioEngine `interrupted`,
/// `controlChanged`, `routeChanged`, `hold`). It plays on when it was playing as the interruption
/// began, or the system paused it within the slack before (`began` can come after that pause), and
/// the end says `shouldResume`. A pause nothing resumes by itself (the listener's, headphones gone,
/// the book's end) ends that: headphones gone while an interruption holds the book paused too
/// (fe#320), or its end would play the book on whatever route is left.
struct InterruptionResume {
  /// When the system last paused the player; a pause the listener made clears it.
  private(set) var systemPausedAt: StartRefusal.Stamp?
  /// The interruption that began finds the book to play on at its end.
  private(set) var pending = false

  /// The system paused the player (suspended, an interruption's pause before its `began`).
  mutating func systemPaused(at now: StartRefusal.Stamp) { systemPausedAt = now }

  /// An interruption began (Siri, a call), the book `playing` or not.
  mutating func began(playing: Bool, at now: StartRefusal.Stamp) {
    pending = playing || StartRefusal.withinSlack(of: systemPausedAt, at: now)
  }

  /// The interruption ended: whether the book plays again. Asked once.
  mutating func ended(shouldResume: Bool) -> Bool {
    defer { pending = false }
    return pending && shouldResume
  }

  /// A pause nothing resumes by itself: the listener's, headphones gone (playing, settling or held
  /// by an interruption), the book's end. Neither an interruption under way nor one beginning
  /// within the slack of an earlier system pause plays it again.
  mutating func held() {
    pending = false
    systemPausedAt = nil
  }
}
