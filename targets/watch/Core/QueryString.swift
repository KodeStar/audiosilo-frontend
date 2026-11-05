// A request's query string, encoded by hand. URLComponents' `queryItems` leaves `;` and `+`
// raw: Go (1.17 and later) drops any query pair holding a raw `;`, so a book path with one
// would reach the server as no `path` at all, and `+` reads as a space. Every character but
// RFC 3986's unreserved ones is percent-encoded (the phone's URLSearchParams encodes `;` too).
import Foundation

enum QueryString {
  /// The unreserved characters (RFC 3986 section 2.3), the only ones sent as they are.
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  /// `name=value` pairs sorted by name, joined with `&`.
  static func encode(_ query: [String: String]) -> String {
    query.sorted { $0.key < $1.key }.map { "\(escape($0.key))=\(escape($0.value))" }.joined(separator: "&")
  }

  /// One name or value, percent-encoded as UTF-8.
  static func escape(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
  }
}
