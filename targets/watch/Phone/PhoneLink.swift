// The watch's ONE `WCSessionDelegate` (nothing else may set `WCSession.default.delegate`):
// `pair`, `book` and `remove` in (sendMessage while reachable, transferUserInfo otherwise, delivered
// even when the app was closed), `watch-state` out (updateApplicationContext, the latest only).
// No sync relay through the phone (decision 2): with the phone in reach watchOS already routes
// the watch's own URLSession through it. Activated at launch, before any message can arrive.
import Foundation
import WatchConnectivity

final class PhoneLink: NSObject, WCSessionDelegate, @unchecked Sendable {
  static let shared = PhoneLink()
  /// How long a wake for the phone's messages waits for the session to hand them over.
  static let WAKE_LIMIT: TimeInterval = 20

  /// Told of every message the contract knows, on the main queue. Messages that arrive before
  /// it is set wait for it.
  var onMessage: ((PhoneMessage) -> Void)? {
    didSet { drain() }
  }

  private var waiting: [PhoneMessage] = []
  /// What the phone is still owed (main queue only).
  private var publication = StatePublication()

  func activate() {
    guard WCSession.isSupported() else { return }
    let s = WCSession.default
    s.delegate = self
    s.activate()
  }

  /// A wake for the phone's messages (`backgroundTask(.watchConnectivity)`): until the session
  /// holds no more of them, `WAKE_LIMIT` at most.
  func contentDelivered() async {
    guard WCSession.isSupported() else { return }
    let s = WCSession.default
    let giveUpAt = Date().addingTimeInterval(Self.WAKE_LIMIT)
    while Date() < giveUpAt, s.activationState != .activated || s.hasContentPending {
      try? await Task.sleep(for: .milliseconds(200))
    }
  }

  /// Send the watch's state to the phone (the latest wins; sent once the session is active).
  func publish(_ state: WatchState) {
    DispatchQueue.main.async {
      guard self.publication.update(state) else { return }
      self.sendState()
    }
  }

  /// A natural moment for a state the session has not taken yet: its activation, a return to the
  /// foreground, a reachability or companion change. No timer.
  func retryState() {
    DispatchQueue.main.async { self.sendState() }
  }

  private func sendState() {
    guard let state = publication.due, WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
    do {
      // Content identical to the session's last context returns success and sends nothing, so it
      // needs no case of its own. A refusal (WCError 7018, the companion not known yet) throws.
      try WCSession.default.updateApplicationContext(PhoneMessages.encode(state))
      publication.tookIt(state)
    } catch {
      // Still due: `retryState` tries again.
    }
  }

  private func receive(_ dict: [String: Any]) {
    guard let m = PhoneMessages.decode(dict) else { return }  // unknown or newer: ignored
    DispatchQueue.main.async {
      self.waiting.append(m)
      self.drain()
    }
  }

  private func drain() {
    guard let handler = onMessage else { return }
    let pending = waiting
    waiting = []
    pending.forEach(handler)
  }

  // MARK: - WCSessionDelegate

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    retryState()
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    retryState()
  }

  func sessionCompanionAppInstalledDidChange(_ session: WCSession) {
    retryState()
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    receive(message)
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    receive(message)
    replyHandler(["v": PhoneMessages.VERSION, "received": true])
  }

  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    receive(userInfo)
  }
}
