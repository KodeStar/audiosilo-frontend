import Foundation

/// Which of a book's headers may go with a request (fe#295): the iOS twin of Android's
/// `AuthScope` + `AuthHolder`. A track's headers are the session token (`Authorization`) and,
/// for a server behind an auth proxy, the proxy headers (fe#167). They are credentials, so:
/// - only to the origin they were given for (the track's own URL: the stream itself, and its
///   cover only when the cover is on that origin), never to another host or port;
/// - every one to an https origin, but to a plain-http one only `Authorization` (which the app
///   sends a server on the house network over http too), never a proxy header.
/// The JS side already holds the same line (`proxyHeaderRecord`); this holds it on its own,
/// so a set handed over with an http track never crosses the network in the clear. What a
/// redirect does with a request's headers is URLSession's rule, not this one's (CONVENTIONS.md).
/// Pure Foundation, so the host self-check (SelfCheck/run.sh) covers it.
enum AuthScope {
  /// `scheme://host:port`, lower-cased, with the scheme's default port when none is named;
  /// nil without a scheme or a host (a `file://` URL has no host: nothing goes to it).
  static func origin(_ url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(),
          let host = url.host?.lowercased(), !host.isEmpty else { return nil }
    let port: Int
    if let p = url.port {
      port = p
    } else if scheme == "https" {
      port = 443
    } else if scheme == "http" {
      port = 80
    } else {
      port = -1
    }
    return "\(scheme)://\(host):\(port)"
  }

  /// The headers a request to `url` may carry of `headers`, given for requests to `scope`'s
  /// origin (the track's URL): none to any other origin; to an https one all of them; to
  /// any other only `Authorization`. Nil when nothing is left.
  static func headers(for url: URL, from headers: [String: String]?, scope: URL) -> [String: String]? {
    guard let headers = headers, !headers.isEmpty,
          let target = origin(url), target == origin(scope) else { return nil }
    let kept = target.hasPrefix("https://")
      ? headers
      : headers.filter { $0.key.caseInsensitiveCompare("Authorization") == .orderedSame }
    return kept.isEmpty ? nil : kept
  }
}
