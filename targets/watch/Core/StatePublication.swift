// Which `watch-state` the phone is still owed. A launch starts owing the state whatever it is, so
// a reinstall or a sign-out corrects a phone still holding an older one; after that only a change
// is owed. A state counts as handed over only once the session took it: a refused send stays
// owed and goes at the next natural moment (`PhoneLink`), with no timer of its own.
import Foundation

struct StatePublication: Sendable {
  /// The state to report: the latest wins.
  private(set) var latest: WatchState?
  /// The one the session last took, this launch.
  private var handedOver: WatchState?

  /// What to send now, nil when the session already holds the latest (or there is none yet).
  var due: WatchState? { latest == handedOver ? nil : latest }

  mutating func update(_ state: WatchState) {
    latest = state
  }

  /// The session took `state`. That includes content identical to its last context: it then
  /// returns success and sends nothing, the counterpart already holds or will get that context.
  mutating func tookIt(_ state: WatchState) {
    handedOver = state
  }
}
