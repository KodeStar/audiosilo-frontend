// The watch's identity on every request (decision 12, CROSS-REPO section 20):
// `X-AudioSilo-Client: audiosilo-watch/<CFBundleShortVersionString> (watchos)`. The server
// keeps it per token (`auth.ParseClient`), so the console names the watch, and an app that is
// not "AudioSilo" sees no podcast libraries.
import Foundation

enum ClientHeader {
  static let name = "X-AudioSilo-Client"
  static let app = "audiosilo-watch"
  static let platform = "watchos"

  /// The header value for this build's version. A version the server's pattern would refuse
  /// (`[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}`) is reduced to the characters it takes, else "0".
  static func value(version: String?) -> String {
    let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+_-")
    var v = String((version ?? "").filter { allowed.contains($0) }.prefix(32))
    while let first = v.first, !(first.isLetter || first.isNumber) { v.removeFirst() }
    return "\(app)/\(v.isEmpty ? "0" : v) (\(platform))"
  }
}
