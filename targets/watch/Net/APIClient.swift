// The watch's server client: `Authorization: Bearer` (never `?token=`), the identity header on
// every request (decision 12), JSON through `Wire`. No `NWPathMonitor` gating (decision 3, W0:
// it reports `unsatisfied` while URLSession works): every call is tried, and a failure with no
// answer (`URLError`) is what offline means. A server's own non-2xx answer throws `APIError`.
import Foundation

/// This build's version (`CFBundleShortVersionString`).
let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"

final class APIClient: ListeningSyncTransport, @unchecked Sendable {
  /// The ordinary request budget.
  static let TIMEOUT: TimeInterval = 20
  /// An unscanned book folder is indexed on demand by `/item` and `/chapters` (fe#154).
  static let UPSTREAM_TIMEOUT: TimeInterval = 30
  /// How long a home address gets to answer the tokenless probe.
  static let PROBE_TIMEOUT: TimeInterval = 2.5

  let base: String
  private let token: String?
  private let session: URLSession

  static let sharedSession: URLSession = {
    let c = URLSessionConfiguration.default
    c.urlCache = nil
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.timeoutIntervalForRequest = TIMEOUT
    c.allowsExpensiveNetworkAccess = true
    c.allowsConstrainedNetworkAccess = true
    return URLSession(configuration: c)
  }()

  init(base: String, token: String?, session: URLSession = APIClient.sharedSession) {
    self.base = AddressPicker.trimSlashes(base)
    self.token = token
    self.session = session
  }

  // MARK: - Requests

  func url(_ path: String, query: [String: String] = [:]) -> URL? {
    guard var c = URLComponents(string: base + "/api/v1" + path) else { return nil }
    if !query.isEmpty {
      c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
      // `+` is a space to the server's query parser: send it encoded.
      c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
    }
    return c.url
  }

  /// A request with the identity header and, when signed in, the bearer token.
  func request(_ method: String, _ path: String, query: [String: String] = [:], body: Data? = nil,
               timeout: TimeInterval = APIClient.TIMEOUT) throws -> URLRequest
  {
    guard let u = url(path, query: query) else { throw URLError(.badURL) }
    var r = URLRequest(url: u, timeoutInterval: timeout)
    r.httpMethod = method
    r.setValue(ClientHeader.value(version: appVersion), forHTTPHeaderField: ClientHeader.name)
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      r.httpBody = body
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return r
  }

  func send<T: Decodable>(_ r: URLRequest, as: T.Type = T.self) async throws -> T {
    let (data, response) = try await session.data(for: r)
    try Self.check(response, data)
    return try Wire.decoder.decode(T.self, from: data)
  }

  /// Throw the server's answer as an `APIError` unless it is a success.
  static func check(_ response: URLResponse, _ data: Data?) throws {
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    guard !(200..<300).contains(http.statusCode) else { return }
    throw APIError(status: http.statusCode, body: data, retryAfterHeader: http.value(forHTTPHeaderField: "Retry-After"))
  }

  private func json<B: Encodable>(_ body: B) throws -> Data { try Wire.encoder.encode(body) }

  // MARK: - Routes

  func serverInfo(timeout: TimeInterval = APIClient.TIMEOUT) async throws -> ServerInfo {
    try await send(request("GET", "/server", timeout: timeout))
  }

  func exchange(pairingToken: String, deviceName: String) async throws -> AuthSession {
    struct Body: Encodable { var pairingToken: String; var deviceName: String }
    return try await send(request("POST", "/auth/exchange", body: json(Body(pairingToken: pairingToken, deviceName: deviceName))))
  }

  func allProgress() async throws -> [ProgressRow] {
    let list: ProgressList = try await send(request("GET", "/me/progress"))
    return list.progress ?? []
  }

  func progress(_ ref: BookRef) async throws -> ProgressRow? {
    struct One: Decodable { var progress: ProgressRow? }
    let one: One = try await send(request("GET", "/libraries/\(ref.libraryId)/progress", query: ["path": ref.path]))
    return one.progress
  }

  func item(_ ref: BookRef) async throws -> Book {
    try await send(request("GET", "/libraries/\(ref.libraryId)/item", query: ["path": ref.path], timeout: Self.UPSTREAM_TIMEOUT))
  }

  func chapters(_ ref: BookRef) async throws -> ChaptersResponse {
    try await send(request("GET", "/libraries/\(ref.libraryId)/chapters", query: ["path": ref.path], timeout: Self.UPSTREAM_TIMEOUT))
  }

  /// `POST .../renditions {"kind":"watch"}`: queue every file of the book (202).
  func prepareRenditions(_ ref: BookRef) async throws -> RenditionsAnswer {
    struct Body: Encodable { var kind = "watch" }
    return try await send(request("POST", "/libraries/\(ref.libraryId)/renditions", query: ["path": ref.path], body: json(Body())))
  }

  /// `GET .../renditions?kind=watch`: where each file stands, queueing nothing.
  func renditionStatus(_ ref: BookRef) async throws -> RenditionsAnswer {
    try await send(request("GET", "/libraries/\(ref.libraryId)/renditions", query: ["path": ref.path, "kind": "watch"]))
  }

  /// A file's watch rendition as a download (Bearer, resumable with Range).
  func renditionDownload(libraryId: Int, file: String) throws -> URLRequest {
    try request("GET", "/libraries/\(libraryId)/stream", query: ["path": file, "rendition": "watch", "download": "1"])
  }

  /// `POST /auth/logout`: end this watch's token on the server (signing out).
  func logout() async throws {
    let (data, response) = try await session.data(for: request("POST", "/auth/logout", timeout: Self.PROBE_TIMEOUT * 2))
    try Self.check(response, data)
  }

  /// `POST /me/listening/sync` (foreground; SyncUploader does the background upload).
  func syncListening(_ body: SyncRequest) async throws -> SyncResponse {
    try await send(request("POST", "/me/listening/sync", body: json(body)))
  }

  /// Ask `url` who it is with NO token: its `server_id`, else nil. Never throws.
  static func probeServerId(_ url: String) async -> String? {
    let info = try? await APIClient(base: url, token: nil).serverInfo(timeout: PROBE_TIMEOUT)
    return info?.serverId
  }

  /// Whether an error means the request timed out (no fallback to a home address after one).
  static func isTimeout(_ error: Error) -> Bool {
    (error as? URLError)?.code == .timedOut
  }
}
