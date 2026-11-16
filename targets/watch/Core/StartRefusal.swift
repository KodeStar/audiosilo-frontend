// A play whose audio never moved: the player stopped before its first tick. That is often the
// system pausing it, not a failed start: Siri, a call or an alert (an interruption whose `began`
// can arrive up to INTERRUPTION_SLACK after the pause) or headphones that went away (a route change
// whose old device is gone). So "could not start" waits out the slack, and either of those within
// it says the pause was the system's: nothing is shown. The engine carries this out
// (WatchAudioEngine `controlChanged`, `interrupted`, `routeChanged`).
import Foundation

struct StartRefusal {
  /// How long after the system paused the player its interruption's `began` can still arrive.
  static let INTERRUPTION_SLACK: TimeInterval = 2

  /// When the start was refused, while its message waits.
  private(set) var refusedAt: Date?

  /// The player stopped before its audio moved: the message waits for the slack.
  mutating func refused(at now: Date) { refusedAt = now }

  /// An interruption began, or the route's old device went: a refusal within the slack was the
  /// system's pause, so it says nothing.
  mutating func explained(at now: Date) {
    guard let at = refusedAt, now.timeIntervalSince(at) < Self.INTERRUPTION_SLACK else { return }
    refusedAt = nil
  }

  /// A new play, a load, a stop or a failure with its own message: an earlier refusal says nothing more.
  mutating func reset() { refusedAt = nil }

  /// The message once the slack has passed with nothing explaining the refusal; given once.
  mutating func message(at now: Date) -> String? {
    guard let at = refusedAt, now.timeIntervalSince(at) >= Self.INTERRUPTION_SLACK else { return nil }
    refusedAt = nil
    return PlaybackFailure.audioStart.message
  }
}

/// A route change, read from `AVAudioSession.routeChangeNotification` (Core has no AVFoundation).
enum RouteChange {
  /// The old device went (headphones off or out of range: `oldDeviceUnavailable`).
  case deviceGone
  case other

  /// Whether it pauses the play. Headphones gone pause it, as on the phone, also while its queue
  /// still settles: that player is held paused on purpose, so the system pauses nothing, and once
  /// the queue lands it would start on whatever route is left. Paused already, nothing changes.
  func pauses(playing: Bool) -> Bool { self == .deviceGone && playing }

  /// Whether it explains a refused start (`StartRefusal.explained`).
  var explainsRefusal: Bool { self == .deviceGone }
}
