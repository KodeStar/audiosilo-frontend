// The watch's ONE `WCSessionDelegate` (nothing else may set `WCSession.default.delegate`):
// `pair` and `book` in (sendMessage while reachable, transferUserInfo otherwise, delivered
// even when the app was closed), `watch-state` out (updateApplicationContext, the latest only).
// No sync relay through the phone (decision 2): with the phone in reach watchOS already routes
// the watch's own URLSession through it. Activated at launch, before any message can arrive.
import Foundation
import WatchConnectivity

final class PhoneLink: NSObject, WCSessionDelegate, @unchecked Sendable {
  static let shared = PhoneLink()

  /// Told of every message the contract knows, on the main queue. Messages that arrive before
  /// it is set wait for it.
  var onMessage: ((PhoneMessage) -> Void)? {
    didSet { drain() }
  }

  private var waiting: [PhoneMessage] = []
  private var lastState: [String: Any]?
  /// The state last handed over (an unchanged one is not sent again).
  private var published: WatchState?

  func activate() {
    guard WCSession.isSupported() else { return }
    let s = WCSession.default
    s.delegate = self
    s.activate()
  }

  /// Send the watch's state to the phone (the latest wins; sent once the session is active).
  func publish(_ state: WatchState) {
    DispatchQueue.main.async {
      guard state != self.published else { return }
      self.published = state
      self.lastState = PhoneMessages.encode(state)
      self.sendState()
    }
  }

  private func sendState() {
    guard let plist = lastState, WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
    try? WCSession.default.updateApplicationContext(plist)
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
    DispatchQueue.main.async { self.sendState() }
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
