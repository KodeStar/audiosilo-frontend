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
  /// The wakes waiting (the system can hand over a second before the first's events are in;
  /// each one's background task completes only when its wait returns).
  private var waiting: [CheckedContinuation<Void, Never>] = []
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
      waiting.append(c)
      lock.unlock()
    }
  }

  /// `urlSessionDidFinishEvents`: resolve every wait on the main queue, after what the
  /// delegate already handed it.
  func finished() {
    lock.lock()
    let done = waiting
    waiting = []
    if done.isEmpty { finishedEarly = true }
    lock.unlock()
    DispatchQueue.main.async { done.forEach { $0.resume() } }
  }
}
