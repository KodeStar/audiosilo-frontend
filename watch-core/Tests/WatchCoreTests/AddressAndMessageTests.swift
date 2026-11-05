// Address picking (src/lib/server-address.test.ts, src/lib/url-host.test.ts and
// connect-model.test.ts's pairingFallback), the rendition state machine, the phone-watch
// messages, the client header and the wire shapes.
import XCTest

@testable import WatchCore

/// A probe that records every address it was asked (with no token: it is given only a URL)
/// and answers from `ids`.
final class ProbeLog {
  var asked: [String] = []
  var ids: [String: String]
  init(_ ids: [String: String] = [:]) { self.ids = ids }
  var probe: ServerIdProbe {
    { url in
      self.asked.append(url)
      return self.ids[url]
    }
  }
}

final class URLEndpointTests: XCTestCase {
  func testReadsSchemeHostAndPortWithTheSchemesDefault() {
    XCTAssertEqual(URLEndpoint("HTTPS://Books.Example.com:8443/api"), URLEndpoint(scheme: "https", host: "books.example.com", port: "8443"))
    XCTAssertEqual(URLEndpoint("https://books.example.com"), URLEndpoint(scheme: "https", host: "books.example.com", port: "443"))
    XCTAssertEqual(URLEndpoint("http://192.168.0.5"), URLEndpoint(scheme: "http", host: "192.168.0.5", port: "80"))
    XCTAssertEqual(URLEndpoint("http://[::1]:80")?.host, "::1")
    XCTAssertEqual(URLEndpoint("https://user@books.example.com")?.host, "books.example.com")
    XCTAssertNil(URLEndpoint("nope"))
    XCTAssertNil(URLEndpoint("http://host:x"))
  }
}

extension URLEndpoint {
  init(scheme: String, host: String, port: String) {
    self = URLEndpoint("\(scheme)://\(host):\(port)")!
  }
}

final class AddressPickerTests: XCTestCase {
  let addrs = ServerAddresses(home: "http://192.168.0.5:8080", away: "https://books.example.com")

  func testHomeOnlyOnThisServersId() {
    XCTAssertEqual(AddressPicker.choose(serverURL: "https://paired", addresses: addrs, serverId: "srv", homeServerId: "srv"), addrs.home)
    XCTAssertEqual(AddressPicker.choose(serverURL: "https://paired", addresses: addrs, serverId: "srv", homeServerId: "other"), addrs.away)
    XCTAssertEqual(AddressPicker.choose(serverURL: "https://paired", addresses: addrs, serverId: "srv", homeServerId: nil), addrs.away)
    XCTAssertEqual(AddressPicker.choose(serverURL: "https://paired", addresses: ServerAddresses(home: "http://h"), serverId: "srv", homeServerId: nil), "https://paired")
    XCTAssertEqual(AddressPicker.choose(serverURL: "https://paired", addresses: nil, serverId: "srv", homeServerId: "srv"), "https://paired")
  }

  // No pick yet (a launch, before the probe): the token does not go home unproven while another
  // address is known.
  func testWithNoPickHomeIsNotUsedWhileAnotherIsKnown() {
    let lan = "http://192.168.1.10:8080"
    let away = "https://books.example"
    XCTAssertEqual(AddressPicker.unproven(serverURL: lan, addresses: ServerAddresses(home: lan, away: away)), away)
    XCTAssertEqual(AddressPicker.unproven(serverURL: away, addresses: ServerAddresses(home: lan, away: nil)), away)
    // Nothing else is known: the phone's rule, the paired URL.
    XCTAssertEqual(AddressPicker.unproven(serverURL: lan, addresses: ServerAddresses(home: lan, away: nil)), lan)
    XCTAssertEqual(AddressPicker.unproven(serverURL: away, addresses: nil), away)
  }

  // The system may send it from another network, where the same private address can be another
  // box: never to a home address.
  func testASendTheSystemMakesLaterNeverGoesHome() {
    let lan = "http://192.168.1.10:8080"
    let away = "https://books.example"
    XCTAssertEqual(AddressPicker.unattended(serverURL: lan, addresses: ServerAddresses(home: lan, away: away)), away)
    XCTAssertEqual(AddressPicker.unattended(serverURL: away, addresses: ServerAddresses(home: lan, away: nil)), away)
    XCTAssertEqual(AddressPicker.unattended(serverURL: away, addresses: nil), away)
    XCTAssertNil(AddressPicker.unattended(serverURL: lan, addresses: ServerAddresses(home: lan, away: nil)))
    XCTAssertNil(AddressPicker.unattended(serverURL: lan + "/", addresses: ServerAddresses(home: lan, away: nil)))
  }

  func testPickProbesHomeWithNoTokenOnlyWhenThereIsOne() async {
    let log = ProbeLog(["http://192.168.0.5:8080": "srv"])
    let url = await AddressPicker.pick(serverURL: "https://paired", addresses: addrs, serverId: "srv", probe: log.probe)
    XCTAssertEqual(url, addrs.home)
    XCTAssertEqual(log.asked, ["http://192.168.0.5:8080"])
    let none = ProbeLog()
    _ = await AddressPicker.pick(serverURL: "https://paired", addresses: ServerAddresses(away: "https://a"), serverId: "srv", probe: none.probe)
    XCTAssertEqual(none.asked, [])
  }

  func testOwnAddresses() {
    XCTAssertTrue(AddressPicker.isOwn("http://192.168.0.5:8080/", serverURL: "https://paired", addresses: addrs))
    XCTAssertTrue(AddressPicker.isOwn("https://paired", serverURL: "https://paired/", addresses: nil))
    XCTAssertFalse(AddressPicker.isOwn("http://evil", serverURL: "https://paired", addresses: addrs))
  }

  // mergeAddresses (src/lib/server-address.test.ts).
  func testMergeKeepsWhatItKnewWhenNothingWasSaid() {
    XCTAssertEqual(AddressPicker.merge(prior: ServerAddresses(home: addrs.home), fresh: nil), ServerAddresses(home: addrs.home))
    XCTAssertNil(AddressPicker.merge(prior: nil, fresh: nil))
  }

  func testMergeTakesANewHomeAndAway() {
    XCTAssertEqual(AddressPicker.merge(prior: ServerAddresses(home: "http://10.0.0.2"), fresh: addrs), addrs)
  }

  func testMergeKeepsTheKnownHomeWhenTheAnswerLacksOne() {
    // An exchange read through the away address (or a reverse proxy): the server cannot derive home.
    XCTAssertEqual(AddressPicker.merge(prior: addrs, fresh: ServerAddresses(away: addrs.away)), addrs)
  }

  func testMergeDropsAnAwayAddressTheServerNoLongerHas() {
    XCTAssertEqual(AddressPicker.merge(prior: addrs, fresh: ServerAddresses()), ServerAddresses(home: addrs.home))
    XCTAssertNil(AddressPicker.merge(prior: ServerAddresses(away: addrs.away), fresh: ServerAddresses()))
  }

  func testMergeDropsAKeptHomeThatBecameTheAwayAddress() {
    XCTAssertEqual(AddressPicker.merge(prior: ServerAddresses(home: addrs.away), fresh: ServerAddresses(away: addrs.away)),
                   ServerAddresses(away: addrs.away))
    XCTAssertEqual(AddressPicker.merge(prior: nil, fresh: ServerAddresses(home: "https://books.example.com/", away: addrs.away)),
                   ServerAddresses(away: addrs.away))
  }

  func testMergeTreatsAnEmptyAddressAsAbsent() {
    XCTAssertEqual(AddressPicker.merge(prior: addrs, fresh: ServerAddresses(home: "", away: addrs.away)), ServerAddresses(away: addrs.away))
    XCTAssertNil(AddressPicker.merge(prior: nil, fresh: ServerAddresses(home: "", away: "")))
  }

  // pairingFallback's rule.
  let base = "https://192.168.0.5:8443"
  let home = "http://192.168.0.5:8443"

  func testFallbackToHomeHttpOnTheSameHostAndPortWhenTheProbeMatches() async {
    let log = ProbeLog([home: "srv"])
    let got = await AddressPicker.pairingFallback(base: base, home: home, serverId: "srv", timedOut: false, probe: log.probe)
    XCTAssertEqual(got, home)
  }

  func testNoFallbackOnATimeoutAnotherHostOrPortAnHttpsHomeOrAnotherServer() async {
    let log = ProbeLog([home: "srv", "http://192.168.0.6:8443": "srv", "http://192.168.0.5:80": "srv"])
    let p = log.probe
    let timeout = await AddressPicker.pairingFallback(base: base, home: home, serverId: "srv", timedOut: true, probe: p)
    let otherHost = await AddressPicker.pairingFallback(base: base, home: "http://192.168.0.6:8443", serverId: "srv", timedOut: false, probe: p)
    let otherPort = await AddressPicker.pairingFallback(base: base, home: "http://192.168.0.5:80", serverId: "srv", timedOut: false, probe: p)
    let httpBase = await AddressPicker.pairingFallback(base: "http://192.168.0.5:8443", home: home, serverId: "srv", timedOut: false, probe: p)
    let noId = await AddressPicker.pairingFallback(base: base, home: home, serverId: nil, timedOut: false, probe: p)
    XCTAssertNil(timeout)
    XCTAssertNil(otherHost)
    XCTAssertNil(otherPort)
    XCTAssertNil(httpBase)
    XCTAssertNil(noId)
    XCTAssertEqual(log.asked, [], "never asked: nothing qualified")
    let wrong = ProbeLog([home: "someone-else"])
    let mismatch = await AddressPicker.pairingFallback(base: base, home: home, serverId: "srv", timedOut: false, probe: wrong.probe)
    XCTAssertNil(mismatch)
  }

  struct TLSFailure: Error {}
  struct Timeout: Error {}

  func testExchangeTriesBaseThenAwayThenHomeAndNeverSendsTheTokenHomeBeforeTheProbe() async throws {
    var tried: [String] = []
    let log = ProbeLog([home: "srv"])
    let result = try await AddressPicker.exchange(
      base: base, addresses: ServerAddresses(home: home, away: "https://books.example.com"), serverId: "srv",
      attempt: { url -> String in
        tried.append(url)
        if url == self.home {
          XCTAssertEqual(log.asked, [self.home], "home was probed (tokenless) before the token went there")
          return "session"
        }
        throw TLSFailure()
      },
      isTimeout: { $0 is Timeout }, probe: log.probe)
    XCTAssertEqual(tried, [base, "https://books.example.com", home])
    XCTAssertEqual(result.base, home)
  }

  func testExchangeStopsAtAServersOwnAnswer() async {
    var tried: [String] = []
    let log = ProbeLog([home: "srv"])
    do {
      _ = try await AddressPicker.exchange(
        base: base, addresses: ServerAddresses(home: home, away: "https://away"), serverId: "srv",
        attempt: { url -> String in
          tried.append(url)
          throw APIError(status: 401, message: "invalid pairing token")
        }, isTimeout: { _ in false }, probe: log.probe)
      XCTFail("should throw")
    } catch let e as APIError {
      XCTAssertEqual(e.status, 401)
    } catch { XCTFail("\(error)") }
    XCTAssertEqual(tried, [base])
    XCTAssertEqual(log.asked, [])
  }

  func testExchangeAfterATimeoutNeverTriesHome() async {
    var tried: [String] = []
    let log = ProbeLog([home: "srv"])
    do {
      _ = try await AddressPicker.exchange(
        base: base, addresses: ServerAddresses(home: home), serverId: "srv",
        attempt: { url -> String in
          tried.append(url)
          throw Timeout()
        }, isTimeout: { $0 is Timeout }, probe: log.probe)
      XCTFail("should throw")
    } catch {
      XCTAssertTrue(error is Timeout, "the base's own error is reported")
    }
    XCTAssertEqual(tried, [base])
  }
}

final class RenditionPlanTests: XCTestCase {
  func f(_ path: String, _ state: String, bytes: Int64? = nil, retry: Double? = nil) -> RenditionFile {
    RenditionFile(path: path, state: state, bytes: bytes, retryAfterSeconds: retry)
  }

  func testAllReadyIsDone() {
    let s = RenditionPlan.step(RenditionsAnswer(kind: "watch", files: [f("a", "ready", bytes: 10), f("b", "ready", bytes: 20)]))
    XCTAssertEqual(s.action, .done)
    XCTAssertEqual(s.ready.map(\.path), ["a", "b"])
  }

  func testPendingPollsAndHandsOverTheReadyOnes() {
    let s = RenditionPlan.step(RenditionsAnswer(kind: "watch", files: [f("a", "ready", bytes: 10), f("b", "pending")]))
    XCTAssertEqual(s.action, .poll(after: RenditionPlan.DEFAULT_POLL))
    XCTAssertEqual(s.ready.map(\.path), ["a"])
  }

  func testMissingPreparesAgain() {
    XCTAssertEqual(RenditionPlan.step(RenditionsAnswer(kind: "watch", files: [f("a", "missing"), f("b", "pending")])).action,
                   .prepareAgain(after: RenditionPlan.DEFAULT_POLL))
  }

  func testAFailedFileFailsWithItsRetryAfter() {
    let s = RenditionPlan.step(RenditionsAnswer(kind: "watch", files: [f("a", "ready"), f("b", "failed", retry: 3600), f("c", "failed")]))
    XCTAssertEqual(s.action, .failed(retryAfter: 3600))
  }

  func testRefusals() {
    XCTAssertEqual(RenditionPlan.refusal(APIError(status: 503, code: "rendition_pending", retryAfter: 15)), .retry(after: 15))
    XCTAssertEqual(RenditionPlan.refusal(APIError(status: 503, code: "rendition_error", retryAfter: 60)), .retry(after: 60))
    XCTAssertEqual(RenditionPlan.refusal(APIError(status: 503, code: "rendition_pending", retryAfter: 0)), .retry(after: RenditionPlan.MIN_POLL))
    XCTAssertEqual(RenditionPlan.refusal(APIError(status: 422, code: "rendition_failed", retryAfter: 1200)), .failed(retryAfter: 1200))
    XCTAssertEqual(RenditionPlan.refusal(APIError(status: 404, code: "rendition_unavailable")), .unavailable)
    XCTAssertEqual(RenditionPlan.refusal(APIError(status: 400, code: "bad_rendition")), .unavailable)
    XCTAssertEqual(RenditionPlan.refusal(APIError(status: 404)), .gone)
    XCTAssertEqual(RenditionPlan.refusal(APIError(status: 401)), .signedOut)
  }

  func testARefusalReadsFromItsBodyAndRetryAfter() {
    let e = APIError(status: 503, body: Data(#"{"error":"not yet","code":"rendition_pending"}"#.utf8), retryAfterHeader: "15")
    XCTAssertEqual(e, APIError(status: 503, code: "rendition_pending", message: "not yet", retryAfter: 15))
    XCTAssertEqual(APIError(status: 500, body: Data("<html>".utf8), retryAfterHeader: "soon"), APIError(status: 500))
    XCTAssertNil(RenditionPlan.message(.retry(after: 5)))
    XCTAssertEqual(RenditionPlan.message(.unavailable), "This server can't make books for the watch now.")
  }

  func testAnAnswerMustHoldEveryFileTheTimelinePlays() {
    func files(_ paths: String...) -> RenditionsAnswer {
      RenditionsAnswer(kind: "watch", files: paths.map { RenditionFile(path: $0, state: "ready") })
    }
    XCTAssertTrue(RenditionPlan.covers(files("a", "b"), wanted: ["a", "b"]))
    XCTAssertTrue(RenditionPlan.covers(files("b", "a", "extra"), wanted: ["a", "b"]))
    XCTAssertFalse(RenditionPlan.covers(files(), wanted: ["a"]))
    XCTAssertFalse(RenditionPlan.covers(files("a"), wanted: ["a", "b"]))
    XCTAssertFalse(RenditionPlan.covers(files("other"), wanted: ["a"]))
    XCTAssertFalse(RenditionPlan.covers(files("a"), wanted: []))
  }

  func testOnlyARealRefusalMeansNoChapters() {
    XCTAssertTrue(RenditionPlan.meansNoChapters(APIError(status: 404)))
    XCTAssertTrue(RenditionPlan.meansNoChapters(APIError(status: 403)))
    XCTAssertTrue(RenditionPlan.meansNoChapters(APIError(status: 400)))
    XCTAssertFalse(RenditionPlan.meansNoChapters(APIError(status: 503)))
    XCTAssertFalse(RenditionPlan.meansNoChapters(APIError(status: 500)))
    XCTAssertFalse(RenditionPlan.meansNoChapters(APIError(status: 429)))
    XCTAssertFalse(RenditionPlan.meansNoChapters(APIError(status: 408)))
    XCTAssertFalse(RenditionPlan.meansNoChapters(APIError(status: 401)))
  }

  func testATransferInFlightGoesOnUnlessItWouldKeepSendingTheTokenHome() {
    let home = "http://192.168.1.10:8080"
    let away = "https://books.example"
    func file(_ base: String) -> String { base + "/api/v1/libraries/1/stream?path=a" }
    func keeps(_ from: String, _ to: String, auth: String = "t", wanted: String = "t", home h: String? = home) -> Bool {
      RenditionPlan.keepsTransfer(url: file(from), authorization: auth, wantedURL: file(to), wantedAuthorization: wanted, home: h)
    }
    XCTAssertTrue(keeps(away, away))
    XCTAssertTrue(keeps(away, home), "the pick came home: away goes on working")
    XCTAssertTrue(keeps(home, home))
    XCTAssertFalse(keeps(home, away), "the pick left home")
    XCTAssertFalse(keeps(away, away, auth: "old"), "signed in again since")
    XCTAssertTrue(keeps(home, away, home: nil), "no home address known")
    XCTAssertFalse(RenditionPlan.keepsTransfer(url: file(home), authorization: nil, wantedURL: file(home),
                                               wantedAuthorization: "t", home: home))
  }

  func testADownloadSucceedsOnlyOn200Or206() {
    XCTAssertTrue(RenditionPlan.downloadSucceeded(status: 200))
    XCTAssertTrue(RenditionPlan.downloadSucceeded(status: 206))
    XCTAssertFalse(RenditionPlan.downloadSucceeded(status: 503))
    XCTAssertFalse(RenditionPlan.downloadSucceeded(status: 422))
  }

  func testStorageNeedsTheBytesPlusHeadroom() {
    let files = [f("a", "ready", bytes: 50_000_000), f("b", "pending")]
    let needed = RenditionPlan.neededBytes(files, durations: ["b": 3600])
    XCTAssertEqual(needed, 50_000_000 + 22_000_000)
    XCTAssertTrue(RenditionPlan.fits(needed: needed, free: needed + RenditionPlan.HEADROOM_BYTES))
    XCTAssertFalse(RenditionPlan.fits(needed: needed, free: needed + RenditionPlan.HEADROOM_BYTES - 1))
  }
}

final class PhoneMessagesTests: XCTestCase {
  let pair: [String: Any] = [
    "v": 1, "type": "pair", "server_id": "srv", "server_name": "Home", "user_id": 7, "user_name": "chris",
    "base_url": "https://books.example.com", "server_url": "https://books.example.com",
    "addresses": ["home": "http://192.168.0.5:8080", "away": "https://books.example.com"],
    "pairing_token": "tok", "expires_at": "2026-11-04T12:10:00Z", "phone_name": "Chris's iPhone",
  ]

  func testDecodesAPairMessage() {
    guard case .pair(let p) = PhoneMessages.decode(pair) else { return XCTFail("not a pair") }
    XCTAssertEqual(p.accountId, "srv.7")
    XCTAssertEqual(p.addresses.home, "http://192.168.0.5:8080")
    XCTAssertEqual(p.pairingToken, "tok")
    XCTAssertTrue(p.expired(now: ISOTime.parse("2026-11-04T12:10:00Z")!))
    XCTAssertFalse(p.expired(now: ISOTime.parse("2026-11-04T12:09:59Z")!))
  }

  func testDecodesARemoveMessage() {
    let remove: [String: Any] = ["v": 1, "type": "remove", "server_id": "srv", "user_id": 7, "library_id": 3, "path": "A/B"]
    XCTAssertEqual(
      PhoneMessages.decode(remove),
      .remove(RemoveMessage(serverId: "srv", userId: 7, ref: BookRef(libraryId: 3, path: "A/B"))))
    guard case .remove(let r) = PhoneMessages.decode(remove) else { return XCTFail("not a remove") }
    XCTAssertEqual(r.accountId, "srv.7")
    var newer = remove
    newer["v"] = 2
    XCTAssertNil(PhoneMessages.decode(newer))
    for key in ["server_id", "user_id", "library_id", "path"] {
      var broken = remove
      broken.removeValue(forKey: key)
      XCTAssertNil(PhoneMessages.decode(broken), key)
    }
  }

  func testIgnoresANewerVersionAnUnknownTypeAndAMalformedOne() {
    var newer = pair
    newer["v"] = 2
    XCTAssertNil(PhoneMessages.decode(newer))
    var unknown = pair
    unknown["type"] = "hello"
    XCTAssertNil(PhoneMessages.decode(unknown))
    for key in ["server_id", "user_id", "base_url", "pairing_token", "expires_at"] {
      var broken = pair
      broken.removeValue(forKey: key)
      XCTAssertNil(PhoneMessages.decode(broken), key)
    }
    var notHTTP = pair
    notHTTP["base_url"] = "audiosilo://pair"
    XCTAssertNil(PhoneMessages.decode(notHTTP))
    var badHome = pair
    badHome["addresses"] = ["home": "ftp://x"]
    guard case .pair(let p) = PhoneMessages.decode(badHome) else { return XCTFail() }
    XCTAssertNil(p.addresses.home)
  }

  func testDecodesABookMessage() {
    let m: [String: Any] = ["v": 1, "type": "book", "server_id": "srv", "user_id": 7, "library_id": 2, "path": "A/Book", "title": "Book"]
    guard case .book(let b) = PhoneMessages.decode(m) else { return XCTFail() }
    XCTAssertEqual(b.ref, BookRef(libraryId: 2, path: "A/Book"))
    XCTAssertEqual(b.accountId, "srv.7")
    XCTAssertNil(b.author)
    var noPath = m
    noPath["path"] = ""
    XCTAssertNil(PhoneMessages.decode(noPath))
  }

  func testEncodesWatchStateAsAPropertyList() throws {
    let s = WatchState(signedIn: true, serverId: "srv", userId: 7, appVersion: "2.6.0",
                       books: [WatchStateBook(ref: BookRef(libraryId: 2, path: "A/Book"), title: "Book", state: .downloading, bytes: 10)],
                       unsentEvents: 3, couldntSync: 1, lastSyncAt: ISOTime.parse("2026-11-04T12:00:00Z"))
    let d = PhoneMessages.encode(s)
    XCTAssertTrue(PropertyListSerialization.propertyList(d, isValidFor: .binary))
    XCTAssertEqual(d["type"] as? String, "watch-state")
    XCTAssertEqual(d["v"] as? Int, 1)
    XCTAssertEqual(d["last_sync_at"] as? String, "2026-11-04T12:00:00.000Z")
    XCTAssertEqual((d["books"] as? [[String: Any]])?.first?["state"] as? String, "downloading")
    let signedOut = PhoneMessages.encode(WatchState(signedIn: false, appVersion: "2.6.0", books: [], unsentEvents: 0, couldntSync: 0))
    XCTAssertNil(signedOut["server_id"])
    XCTAssertTrue(PropertyListSerialization.propertyList(signedOut, isValidFor: .binary))
  }
}

final class ClientHeaderAndWireTests: XCTestCase {
  func testTheIdentityHeader() {
    XCTAssertEqual(ClientHeader.name, "X-AudioSilo-Client")
    XCTAssertEqual(ClientHeader.value(version: "2.6.0"), "audiosilo-watch/2.6.0 (watchos)")
    XCTAssertEqual(ClientHeader.value(version: nil), "audiosilo-watch/0 (watchos)")
    XCTAssertEqual(ClientHeader.value(version: "2.6 beta!"), "audiosilo-watch/2.6beta (watchos)")
  }

  func testTheServerGate() throws {
    let new = try Wire.decoder.decode(ServerInfo.self, from: Data(#"{"name":"S","server_id":"srv","version":"2.6.0","capabilities":{"listening_sync":true,"renditions":true},"renditions":["watch"]}"#.utf8))
    XCTAssertTrue(new.supportsWatch)
    let noRenditions = try Wire.decoder.decode(ServerInfo.self, from: Data(#"{"version":"2.5.1","capabilities":{"listening_sync":true}}"#.utf8))
    XCTAssertFalse(noRenditions.supportsWatch)
    let off = try Wire.decoder.decode(ServerInfo.self, from: Data(#"{"capabilities":{"listening_sync":true,"renditions":false},"renditions":[]}"#.utf8))
    XCTAssertFalse(off.supportsWatch)
    let noSync = try Wire.decoder.decode(ServerInfo.self, from: Data(#"{"capabilities":{},"renditions":["watch"]}"#.utf8))
    XCTAssertFalse(noSync.supportsWatch)
  }

  func testDecodesASyncAnswerAndAProgressRowWithOtherPlace() throws {
    let json = #"""
    {"server_time":"2026-10-25T07:41:03.480123Z","results":[{"id":"a","status":"diverged","kept":"stored",
    "other_place":{"position":900,"device_id":"watch","device_name":"W","updated_at":"2026-10-08T11:00:00Z"}}],
    "progress":[{"library_id":3,"path":"Author/Book","position":16800,"duration":61200,"finished":false,
    "playback_speed":1.2,"version":42,"device_id":"d","updated_at":"2026-10-25T07:33:30Z","device_name":"Phone",
    "other_place":{"position":900,"device_id":"watch","device_name":"W","updated_at":"2026-10-08T11:00:00Z"}}]}
    """#
    let a = try Wire.decoder.decode(SyncResponse.self, from: Data(json.utf8))
    XCTAssertEqual(a.results?.first?.otherPlace?.position, 900)
    XCTAssertEqual(a.progress?.first?.version, 42)
    XCTAssertEqual(a.progress?.first?.otherPlace?.deviceId, "watch")
    XCTAssertNotNil(ISOTime.parse(a.serverTime!))
    let none = try Wire.decoder.decode(SyncResponse.self, from: Data(#"{"server_time":"x","results":[],"progress":null}"#.utf8))
    XCTAssertNil(none.progress)
  }

  func testAFinishEventRoundTrips() throws {
    let e = ListeningEvent.finish(FinishEvent(id: "f", kind: "unfinish", libraryId: 2, path: "p", at: "2026-10-25T08:00:00.000Z", baseVersion: 3))
    let data = try Wire.encoder.encode(e)
    let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    XCTAssertEqual(json as NSDictionary, ["id": "f", "kind": "unfinish", "library_id": 2, "path": "p", "at": "2026-10-25T08:00:00.000Z", "base_version": 3] as NSDictionary)
    XCTAssertEqual(try Wire.decoder.decode(ListeningEvent.self, from: data), e)
  }

  func testDecodesABookAndARenditionsAnswer() throws {
    let book = try Wire.decoder.decode(Book.self, from: Data(#"{"id":1,"library_id":2,"rel_path":"A/Book","title":"Book","author":"A","duration":160,"size":15,"files":[{"rel_path":"A/Book/01.mp3","seq":1,"duration":60,"format":"mp3","size":5}],"chapters":[{"index":0,"title":"One","file_index":0,"file_path":"A/Book/01.mp3","start":0,"end":60,"book_offset":0}]}"#.utf8))
    XCTAssertEqual(book.files?.first?.relPath, "A/Book/01.mp3")
    XCTAssertEqual(book.chapters?.first?.filePath, "A/Book/01.mp3")
    let r = try Wire.decoder.decode(RenditionsAnswer.self, from: Data(#"{"kind":"watch","files":[{"path":"A/Book/01.mp3","state":"failed","retry_after_seconds":3600},{"path":"b","state":"ready","bytes":123}]}"#.utf8))
    XCTAssertEqual(r.files[0].retryAfterSeconds, 3600)
    XCTAssertEqual(r.files[1].bytes, 123)
  }
}

final class ContinueOrderTests: XCTestCase {
  func testStartedAndNotFinishedNewestFirstCapped() {
    func r(_ path: String, _ pos: Double, finished: Bool = false, at: String) -> ProgressRow {
      ProgressRow(libraryId: 1, path: path, position: pos, duration: 100, finished: finished, playbackSpeed: 1, version: 1,
                  deviceId: "d", updatedAt: at)
    }
    let rows = [
      r("old", 5, at: "2026-10-01T00:00:00Z"), r("new", 5, at: "2026-10-03T00:00:00.5Z"), r("unstarted", 0, at: "2026-10-04T00:00:00Z"),
      r("done", 100, finished: true, at: "2026-10-05T00:00:00Z"), r("mid", 5, at: "2026-10-02T00:00:00Z"),
    ]
    XCTAssertEqual(ContinueOrder.inProgress(rows, limit: 10).map(\.path), ["new", "mid", "old"])
    XCTAssertEqual(ContinueOrder.inProgress(rows, limit: 2).map(\.path), ["new", "mid"])
  }
}

final class BackgroundWakeTests: XCTestCase {
  func testAWaitResolvesWhenTheEventsArrive() async {
    let wake = BackgroundWake()
    let waiting = Task { await wake.wait(timeout: 30) }
    // Delivered only after the wait is in place, or it would be the early path.
    try? await Task.sleep(nanoseconds: 50_000_000)
    let began = Date()
    wake.finished()
    await waiting.value
    XCTAssertLessThan(Date().timeIntervalSince(began), 5)
  }

  func testAWaitWhoseEventsNeverComeGivesUp() async {
    let wake = BackgroundWake()
    let began = Date()
    await wake.wait(timeout: 0.05)
    XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 0.05)
  }

  func testEventsJustBeforeAWaitCountOlderOnesDoNot() async {
    let clock = Clock()
    let wake = BackgroundWake(clock: { clock.now })
    wake.finished()
    var began = Date()
    await wake.wait(timeout: 30)
    XCTAssertLessThan(Date().timeIntervalSince(began), 5, "a cold launch delivers them before the wait")

    wake.finished()
    clock.advance(BackgroundWake.EARLY_WINDOW + 1)
    began = Date()
    await wake.wait(timeout: 0.05)
    XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 0.05, "an earlier wake's events")
  }

  func testEveryWakeWaitingResolves() async {
    let wake = BackgroundWake()
    let first = Task { await wake.wait(timeout: 30) }
    let second = Task { await wake.wait(timeout: 30) }
    try? await Task.sleep(nanoseconds: 50_000_000)
    wake.finished()
    await first.value
    await second.value
  }
}
