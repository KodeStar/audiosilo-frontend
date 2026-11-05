// The phone's ONE `WCSessionDelegate` (nothing else may set `WCSession.default.delegate`): `pair`
// and `book` out, the watch's `watch-state` in. The other end is targets/watch/Phone/PhoneLink.swift
// and targets/watch/Core/PhoneMessages.swift; the messages are built in src/watch/watch-model.ts.
// WatchConnectivity carries only these: with the phone in reach the watch's own URLSession already
// rides it, so there is no sync relay here.
//
// It is activated at launch from `AudiosiloWatchAppDelegateSubscriber`, so a launch with no phone
// UI (CarPlay first, a background wake) still takes what the watch sends. Every property of the
// session is only meaningful once it is activated, so a question asked sooner waits for that
// (`whenActivated`). State here is touched on the main queue only; the delegate's callbacks arrive
// on a queue of the system's and hop over.
import Foundation
import WatchConnectivity

/// How a message could not go.
enum WatchLinkError: Error {
  /// No paired watch with the app installed (or the session never activated).
  case noWatch
  /// Not a property list: WatchConnectivity would refuse it.
  case badMessage
}

final class WatchLink: NSObject, WCSessionDelegate, @unchecked Sendable {
  static let shared = WatchLink()
  /// Posted on the main queue when anything `snapshot()` says may have changed.
  static let changed = Notification.Name("AudiosiloWatchLinkChanged")

  /// How long a question waits for the session to activate before answering with what it has.
  private static let ACTIVATION_WAIT: TimeInterval = 5
  /// How long a `pair` waits for the watch's reply before it also goes by `transferUserInfo`. A
  /// second copy does no harm: its token is single use, and the watch ignores a failed sign-in
  /// again for an account it holds.
  private static let REPLY_WAIT: TimeInterval = 10

  private var waiting: [() -> Void] = []
  private var activating = false

  /// Idempotent. Runs on the main queue.
  func activate() {
    guard !activating, WCSession.isSupported() else { return }
    activating = true
    let session = WCSession.default
    session.delegate = self
    session.activate()
  }

  /// Run `work` on the main queue once the session has activated, or after `ACTIVATION_WAIT` with
  /// it not (a question answers "no watch" then, never hangs).
  func whenActivated(_ work: @escaping () -> Void) {
    DispatchQueue.main.async {
      self.activate()
      guard WCSession.isSupported(), WCSession.default.activationState != .activated else {
        work()
        return
      }
      // Its own deadline, so a question asked late is not cut short by an earlier one's.
      var ran = false
      let once = {
        guard !ran else { return }
        ran = true
        work()
      }
      self.waiting.append(once)
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.ACTIVATION_WAIT, execute: once)
    }
  }

  private func drain() {
    let pending = waiting
    waiting = []
    pending.forEach { $0() }
  }

  private var active: Bool {
    WCSession.isSupported() && WCSession.default.activationState == .activated
  }

  // MARK: - What the module reads (after `whenActivated`, on the main queue)

  private var isPaired: Bool { active && WCSession.default.isPaired }
  private var isWatchAppInstalled: Bool { isPaired && WCSession.default.isWatchAppInstalled }

  /// Where the latest `watch-state` is copied for a cold start: the folder the system keeps for
  /// this very watch and deletes with it, so a watch paired while the app was not running never
  /// reads the last one's sign-in (no `sessionDidDeactivate` would have told this app).
  private var stateCopy: URL? {
    guard active else { return nil }
    return WCSession.default.watchDirectoryURL?.appendingPathComponent("last-state.plist")
  }

  /// The watch's latest `watch-state`, or nil if it has sent none: what the session keeps for this
  /// watch, else the copy kept here (a cold start).
  private var watchState: [String: Any]? {
    if active, !WCSession.default.receivedApplicationContext.isEmpty {
      return WCSession.default.receivedApplicationContext
    }
    return stateCopy.flatMap { NSDictionary(contentsOf: $0) as? [String: Any] }
  }

  func snapshot() -> [String: Any] {
    var out: [String: Any] = ["paired": isPaired, "installed": isWatchAppInstalled]
    if let state = watchState { out["state"] = state }
    return out
  }

  // MARK: - Sending

  /// `pair`: `sendMessage` when the watch is reachable, else (or if that fails) `transferUserInfo`,
  /// which survives the watch app being closed. When `done` runs the pair is ahead of any `book`
  /// sent after it, which the watch needs: it handles messages in order, and a book for an account
  /// it is not signed in to is only held until it is.
  func sendPair(_ message: [String: Any], done: @escaping (Result<Void, WatchLinkError>) -> Void) {
    whenActivated {
      guard Self.isPropertyList(message) else { return done(.failure(.badMessage)) }
      guard self.isWatchAppInstalled else { return done(.failure(.noWatch)) }
      let session = WCSession.default
      // A pair not yet delivered holds an older token, and a watch still has to sign in for the
      // books queued behind it: this one takes its place, and they follow it.
      let queued = session.outstandingUserInfoTransfers
      queued.filter { Self.type(of: $0.userInfo) == "pair" }.forEach { $0.cancel() }
      var settled = false
      let finish = {
        guard !settled else { return }
        settled = true
        for book in queued where Self.type(of: book.userInfo) == "book" {
          book.cancel()
          session.transferUserInfo(book.userInfo)
        }
        done(.success(()))
      }
      let transfer = {
        guard !settled else { return }
        session.transferUserInfo(message)
        finish()
      }
      guard session.isReachable else { return transfer() }
      session.sendMessage(message, replyHandler: { _ in
        DispatchQueue.main.async(execute: finish)
      }, errorHandler: { _ in
        DispatchQueue.main.async(execute: transfer)
      })
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.REPLY_WAIT, execute: transfer)
    }
  }

  /// `book`: always `transferUserInfo`, delivered in order and when the watch app is closed.
  func sendBook(_ message: [String: Any], done: @escaping (Result<Void, WatchLinkError>) -> Void) {
    whenActivated {
      guard Self.isPropertyList(message) else { return done(.failure(.badMessage)) }
      guard self.isWatchAppInstalled else { return done(.failure(.noWatch)) }
      WCSession.default.transferUserInfo(message)
      done(.success(()))
    }
  }

  private static func type(of message: [String: Any]) -> String? { message["type"] as? String }

  private static func isPropertyList(_ message: [String: Any]) -> Bool {
    PropertyListSerialization.propertyList(message, isValidFor: .binary)
  }

  private func notify() {
    NotificationCenter.default.post(name: Self.changed, object: self)
  }

  // MARK: - WCSessionDelegate

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    DispatchQueue.main.async {
      // One that did not activate is tried again by the next question (`whenActivated`).
      self.activating = activationState == .activated
      self.drain()
      self.notify()
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  /// The listener switched to another watch: the session must be activated again to reach it.
  func sessionDidDeactivate(_ session: WCSession) {
    DispatchQueue.main.async {
      session.activate()
      self.notify()
    }
  }

  /// Paired, or the watch app installed, changed.
  func sessionWatchStateDidChange(_ session: WCSession) {
    DispatchQueue.main.async { self.notify() }
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    DispatchQueue.main.async {
      if let file = self.stateCopy { (applicationContext as NSDictionary).write(to: file, atomically: true) }
      self.notify()
    }
  }
}
