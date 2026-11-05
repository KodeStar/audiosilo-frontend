// What the app's two background URLSessions share (the downloads and the sync upload): their
// configuration. The handshake of a background wake is Core's `BackgroundWake`.
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
