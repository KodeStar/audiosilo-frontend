// What the app's two background URLSessions share (the downloads and the sync upload): their
// configuration, and the handshake of a background wake (`backgroundTask(.urlSession)`), which
// resolves once the system has delivered the session's events.
import Foundation

enum BackgroundSession {
  /// A background session's identifier: the app's bundle id plus `suffix`.
  static func identifier(_ suffix: String) -> String {
    (Bundle.main.bundleIdentifier ?? "app.audiosilo.watchkitapp") + suffix
  }

  static func configuration(_ identifier: String) -> URLSessionConfiguration {
    let c = URLSessionConfiguration.background(withIdentifier: identifier)
    c.isDiscretionary = false
    c.sessionSendsLaunchEvents = true
    c.allowsExpensiveNetworkAccess = true
    c.allowsConstrainedNetworkAccess = true
    return c
  }
}

/// One session's wake: `wait` resolves at `urlSessionDidFinishEvents`, also when those events
/// came before the wait began.
final class BackgroundWake: @unchecked Sendable {
  private let lock = NSLock()
  /// The system's completion for a background wake.
  private var wakeDone: (() -> Void)?
  /// The events were delivered before `wait` waited for them.
  private var finishedEarly = false

  func wait() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      lock.lock()
      if finishedEarly {
        finishedEarly = false
        lock.unlock()
        c.resume()
        return
      }
      wakeDone = { c.resume() }
      lock.unlock()
    }
  }

  /// `urlSessionDidFinishEvents`: resolve the wait on the main queue, after what the delegate
  /// already handed it.
  func finished() {
    lock.lock()
    let done = wakeDone
    wakeDone = nil
    if done == nil { finishedEarly = true }
    lock.unlock()
    DispatchQueue.main.async { done?() }
  }
}
