// Which address the watch talks to, ports of the phone's `src/lib/server-address.ts`
// (`chooseAddress`, `pickAddress`, `mergeAddresses`), `src/lib/url-host.ts` (`urlEndpoint`) and
// `src/components/connect/connect-model.ts` (`withFallback`, `pairingFallback`). CROSS-REPO
// section 7: a home address is used only after a tokenless `GET <home>/api/v1/server` answered
// this account's `server_id`; NEVER does a token (session or pairing) go to a home address
// before that. Self-signed (decision 1): no certificate override; the server's plain-HTTP home
// address is the way in at home, under `pairingFallback`'s rule.
import Foundation

/// An absolute URL's scheme, host and port (the port defaulting to the scheme's).
struct URLEndpoint: Equatable, Sendable {
  var scheme: String
  var host: String
  var port: String

  init?(_ url: String) {
    let s = url.trimmingCharacters(in: .whitespaces)
    guard let schemeEnd = s.range(of: "://") else { return nil }
    let scheme = s[..<schemeEnd.lowerBound].lowercased()
    guard let first = scheme.first, first.isLetter,
          scheme.allSatisfy({ $0.isLetter || $0.isNumber || "+.-".contains($0) })
    else { return nil }
    var rest = Substring(s[schemeEnd.upperBound...])
    if let stop = rest.firstIndex(where: { "/?#".contains($0) }) { rest = rest[..<stop] }
    if let at = rest.lastIndex(of: "@") { rest = rest[rest.index(after: at)...] }
    var host: Substring
    var port: Substring?
    if rest.hasPrefix("[") {
      guard let close = rest.firstIndex(of: "]") else { return nil }
      host = rest[rest.index(after: rest.startIndex)..<close]
      let after = rest[rest.index(after: close)...]
      if after.hasPrefix(":") { port = after.dropFirst() }
    } else if let colon = rest.firstIndex(of: ":") {
      host = rest[..<colon]
      port = rest[rest.index(after: colon)...]
    } else {
      host = rest
    }
    guard !host.isEmpty else { return nil }
    if let p = port, p.isEmpty || !p.allSatisfy(\.isNumber) { return nil }
    self.scheme = scheme
    self.host = host.lowercased()
    self.port = port.map(String.init) ?? (scheme == "https" ? "443" : scheme == "http" ? "80" : "")
  }
}

/// Asks an address who it is with NO token; the `server_id` it answered, else nil. Never throws.
typealias ServerIdProbe = (String) async -> String?

enum AddressPicker {
  /// Two URLs say the same, trailing slashes aside.
  static func sameURL(_ a: String, _ b: String) -> Bool {
    trimSlashes(a) == trimSlashes(b)
  }

  static func trimSlashes(_ s: String) -> String {
    var t = s.trimmingCharacters(in: .whitespaces)
    while t.hasSuffix("/") { t.removeLast() }
    return t
  }

  /// The address when home is not an option: away, else the paired URL.
  static func fallback(serverURL: String, addresses: ServerAddresses?) -> String {
    addresses?.away ?? serverURL
  }

  /// The address before anything was probed: what a home that did not answer leaves, so the
  /// token never goes to a home address unproven while another is known.
  static func unproven(serverURL: String, addresses: ServerAddresses?) -> String {
    addresses?.home == nil ? serverURL : fallback(serverURL: serverURL, addresses: addresses)
  }

  /// The address for a request the system sends later, on whatever network the watch has joined
  /// by then, where nothing can run the probe first: away, else the paired URL; nil when that is
  /// the home address itself (paired on the home network: it syncs in the foreground).
  static func unattended(serverURL: String, addresses: ServerAddresses?) -> String? {
    let url = fallback(serverURL: serverURL, addresses: addresses)
    if let home = addresses?.home, sameURL(url, home) { return nil }
    return url
  }

  /// The pick, given what home answered (`homeServerId`, nil for no answer): home only on this
  /// account's own `server_id`; no home address keeps the paired URL.
  static func choose(serverURL: String, addresses: ServerAddresses?, serverId: String, homeServerId: String?) -> String {
    guard let home = addresses?.home else { return serverURL }
    if let id = homeServerId, id == serverId { return home }
    return fallback(serverURL: serverURL, addresses: addresses)
  }

  /// Pick now: probe home (when there is one, with no token), then `choose`.
  static func pick(serverURL: String, addresses: ServerAddresses?, serverId: String, probe: ServerIdProbe) async -> String {
    guard let home = addresses?.home else { return serverURL }
    return choose(serverURL: serverURL, addresses: addresses, serverId: serverId, homeServerId: await probe(home))
  }

  /// What the watch keeps after the server told it `fresh`, given what it knew before (the
  /// phone's `mergeAddresses`). Nil `fresh` keeps `prior`. Otherwise `away` is the server's
  /// configuration (absent = none) while `home` falls back to `prior`'s: a server with no home
  /// address configured derives it from the request, so an answer read through the away address
  /// cannot know it. A home that became the away address is dropped; empty counts as absent.
  static func merge(prior: ServerAddresses?, fresh: ServerAddresses?) -> ServerAddresses? {
    guard let fresh else { return prior }
    let away = fresh.away.flatMap { $0.isEmpty ? nil : $0 }
    var home = (fresh.home ?? prior?.home).flatMap { $0.isEmpty ? nil : $0 }
    if let h = home, let a = away, sameURL(h, a) { home = nil }
    if home == nil && away == nil { return nil }
    return ServerAddresses(home: home, away: away)
  }

  /// Whether `url` is one of the account's own addresses (a pick that no longer is one falls
  /// back to the paired URL).
  static func isOwn(_ url: String, serverURL: String, addresses: ServerAddresses?) -> Bool {
    sameURL(url, serverURL) || addresses?.home.map { sameURL(url, $0) } == true
      || addresses?.away.map { sameURL(url, $0) } == true
  }

  /// Where to exchange when `base` could not connect without a server answering (and not a
  /// timeout): the `home` address, only when it is plain http on the base's own https host and
  /// port and, asked with no token, answers as exactly `serverId`. Else nil.
  static func pairingFallback(base: String, home: String?, serverId: String?, timedOut: Bool, probe: ServerIdProbe) async
    -> String?
  {
    guard let home, let serverId, !serverId.isEmpty, !timedOut else { return nil }
    guard let b = URLEndpoint(base), let h = URLEndpoint(home), b.scheme == "https", h.scheme == "http" else { return nil }
    guard h.host == b.host, h.port == b.port else { return nil }
    return await probe(home) == serverId ? home : nil
  }

  /// Exchange a pairing token (decision: the pair message's `base_url`, then `away`, then the
  /// home http address under `pairingFallback`'s rule). A server's own answer (`APIError`) at
  /// any address ends it: the token is single use. `attempt` exchanges at a base; `isTimeout`
  /// tells a timeout from other failures. Returns the answer and the base that gave it.
  static func exchange<T>(
    base: String, addresses: ServerAddresses?, serverId: String,
    attempt: (String) async throws -> T, isTimeout: (Error) -> Bool, probe: ServerIdProbe
  ) async throws -> (answer: T, base: String) {
    var firstError: Error
    do {
      return (try await attempt(base), base)
    } catch let e as APIError {
      throw e
    } catch {
      firstError = error
    }
    if let away = addresses?.away, !sameURL(away, base) {
      do {
        return (try await attempt(away), away)
      } catch let e as APIError {
        throw e
      } catch {}
    }
    if let home = await pairingFallback(
      base: base, home: addresses?.home, serverId: serverId, timedOut: isTimeout(firstError), probe: probe)
    {
      do {
        return (try await attempt(home), home)
      } catch let e as APIError {
        throw e
      } catch {}
    }
    throw firstError
  }
}
