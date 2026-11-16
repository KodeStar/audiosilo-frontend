// A play whose audio never moved: the player stopped before its first tick. That is often the
// system pausing it, not a failed start: Siri, a call or an alert (an interruption whose `began`
// can arrive up to INTERRUPTION_SLACK after the pause) or headphones that went away (a route change
// whose old device is gone). So "could not start" waits out the slack, and either of those within
// it says the pause was the system's: nothing is shown. The engine carries this out
// (WatchAudioEngine `controlChanged`, `interrupted`, `routeChanged`): its timer is what waits, so
// the message never depends on the wall clock (set back within the slack, it would never show).
import Foundation

struct StartRefusal {
  /// How long after the system paused the player its interruption's `began` can still arrive.
  static let INTERRUPTION_SLACK: TimeInterval = 2

  /// When the start was refused, while its message waits.
  private(set) var refusedAt: Date?

  /// The player stopped before its audio moved: the message waits for the slack.
  mutating func refused(at now: Date) { refusedAt = now }

  /// Whether `now` is still within the slack of a pause at `pausedAt`.
  static func withinSlack(of pausedAt: Date?, at now: Date) -> Bool {
    pausedAt.map { now.timeIntervalSince($0) < INTERRUPTION_SLACK } ?? false
  }

  /// An interruption began, or the route's old device went: a refusal within the slack was the
  /// system's pause, so it says nothing.
  mutating func explained(at now: Date) {
    if Self.withinSlack(of: refusedAt, at: now) { refusedAt = nil }
  }

  /// A new play, a load, a stop or a failure with its own message: an earlier refusal says nothing more.
  mutating func reset() { refusedAt = nil }

  /// The message of the refusal at `refusal`, asked for when its slack has passed (the engine's
  /// timer) and given once. Nil when that refusal was explained or reset; a newer one waits its own
  /// slack.
  mutating func message(for refusal: Date) -> String? {
    guard refusedAt == refusal else { return nil }
    refusedAt = nil
    return PlaybackFailure.audioStart.message
  }
}
