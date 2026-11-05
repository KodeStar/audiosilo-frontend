// What APIClient sends and reads back: the query string (QueryString: every character but RFC
// 3986's unreserved ones percent-encoded, so Go's query parser reads a book path back exactly; a
// raw `;` drops the pair, a raw `+` is a space), and an answer's `Retry-After`.
import XCTest

@testable import WatchCore

final class QueryStringTests: XCTestCase {
  func testEncodesEverythingButTheUnreservedCharacters() {
    XCTAssertEqual(QueryString.encode(["path": "Smith; Jones/Book 1.m4b"]), "path=Smith%3B%20Jones%2FBook%201.m4b")
    XCTAssertEqual(QueryString.encode(["path": "C++ & Tom=Jerry"]), "path=C%2B%2B%20%26%20Tom%3DJerry")
    XCTAssertEqual(QueryString.encode(["path": "100% #1? a,b"]), "path=100%25%20%231%3F%20a%2Cb")
    XCTAssertEqual(QueryString.encode(["path": "A-Z_a.z~09"]), "path=A-Z_a.z~09")
  }

  func testEncodesNonASCIIAsUTF8() {
    XCTAssertEqual(QueryString.encode(["path": "Brontë/Jane Eyre 📚.mp3"]),
                   "path=Bront%C3%AB%2FJane%20Eyre%20%F0%9F%93%9A.mp3")
  }

  func testSortsByNameAndEncodesNames() {
    XCTAssertEqual(QueryString.encode(["path": "a", "kind": "watch", "download": "1"]), "download=1&kind=watch&path=a")
    XCTAssertEqual(QueryString.encode(["a b": "c"]), "a%20b=c")
    XCTAssertEqual(QueryString.encode([:]), "")
  }

  func testReadsBackAsTheValuesSent() throws {
    let query = ["path": "Smith; Jones/Book +1 & 2=3 %41 #?/Brontë 📚.mp3", "rendition": "watch", "download": "1"]
    var c = try XCTUnwrap(URLComponents(string: "http://192.168.1.10:8080/api/v1/libraries/3/stream"))
    c.percentEncodedQuery = QueryString.encode(query)
    let read = try XCTUnwrap(c.queryItems)
    XCTAssertEqual(Dictionary(uniqueKeysWithValues: read.map { ($0.name, $0.value ?? "") }), query)
    XCTAssertFalse(try XCTUnwrap(c.url).absoluteString.contains(";"))
  }
}

final class RetryAfterTests: XCTestCase {
  // The phone's rule (a finite, non-negative number, else none), capped so a wait slept for in
  // nanoseconds can't overflow a UInt64 and trap.
  func testReadsAFiniteNonNegativeNumberCapped() {
    XCTAssertEqual(APIError.retryAfterSeconds("7"), 7)
    XCTAssertEqual(APIError.retryAfterSeconds(" 2.5 "), 2.5)
    XCTAssertEqual(APIError.retryAfterSeconds("0"), 0)
    XCTAssertEqual(APIError.retryAfterSeconds("99999999999"), APIError.MAX_RETRY_AFTER)
    for bad in ["inf", "infinity", "1e400", "nan", "-5", "abc", "", "Wed, 21 Oct 2026 07:28:00 GMT"] {
      XCTAssertNil(APIError.retryAfterSeconds(bad), bad)
    }
  }

  func testARefusalNeverWaitsLongerThanTheCap() {
    let e = APIError(status: 503, body: nil, retryAfterHeader: "1e300")
    XCTAssertEqual(e.retryAfter, APIError.MAX_RETRY_AFTER)
    guard case .retry(let after) = RenditionPlan.refusal(e) else { return XCTFail("a 503 waits") }
    XCTAssertLessThanOrEqual(after, APIError.MAX_RETRY_AFTER)
    XCTAssertEqual(APIError(status: 503, body: nil, retryAfterHeader: "inf").retryAfter, nil)
  }
}
