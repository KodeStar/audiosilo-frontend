// A document on disk that can't be read now (before the watch's first unlock every file is locked)
// is not one that is missing or damaged: each is told apart, so nothing is written over a file that
// will read later, and the stores read again once it does (fe#219).
import XCTest

@testable import WatchCore

func tempDir(_ test: XCTestCase) throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  test.addTeardownBlock {
    // Readable again, so it can go.
    for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] {
      try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: dir.appendingPathComponent(name).path)
    }
    try? FileManager.default.removeItem(at: dir)
  }
  return dir
}

/// Make `url` unreadable, as a locked file is (skipped where permissions don't hold, as for root).
func lock(_ url: URL) throws {
  try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: url.path)
  try XCTSkipIf(FileManager.default.isReadableFile(atPath: url.path), "permissions are not enforced here")
}

func unlock(_ url: URL) throws {
  try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
}

final class JSONFileTests: XCTestCase {
  func testLoadTellsMissingValueUnreadableAndCorruptApart() throws {
    let dir = try tempDir(self)
    let file = JSONFile<[String]>(url: dir.appendingPathComponent("doc.json"))
    guard case .missing = file.load() else { return XCTFail("no file is missing") }
    XCTAssertTrue(file.write(["one"]))
    guard case .value(let v) = file.load() else { return XCTFail("a stored value") }
    XCTAssertEqual(v, ["one"])
    try lock(file.url)
    guard case .unreadable = file.load() else { return XCTFail("there, but it can't be read") }
    XCTAssertNil(file.read())
    try unlock(file.url)
    try Data("not json".utf8).write(to: file.url)
    guard case .corrupt = file.load() else { return XCTFail("it reads but does not decode") }
    XCTAssertNil(file.read())
  }

  func testMoveAsideKeepsTheFileBesideIt() throws {
    let dir = try tempDir(self)
    let file = JSONFile<[String]>(url: dir.appendingPathComponent("downloads.json"))
    try Data("damaged".utf8).write(to: file.url)
    XCTAssertTrue(file.moveAside(prefix: "downloads-unread-"))
    guard case .missing = file.load() else { return XCTFail("the next write goes over nothing") }
    let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
    let aside = try XCTUnwrap(names.first { $0.hasPrefix("downloads-unread-") && $0.hasSuffix(".json") })
    XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent(aside), encoding: .utf8), "damaged")
    XCTAssertFalse(file.moveAside(prefix: "downloads-unread-"), "nothing left to move")
  }
}

@MainActor
final class StoreReloadTests: XCTestCase {
  // A launch before the first unlock reads none of them; nothing changes them until it can.
  func testAcksAndPlacesReadAgainOnceTheyRead() throws {
    let dir = try tempDir(self)
    let ref = BookRef(libraryId: 1, path: "A/Book")
    let acksURL = dir.appendingPathComponent("acks.json")
    let placesURL = dir.appendingPathComponent("places.json")
    AckStore(url: acksURL).ack(ref, version: 7)
    PlaceStore(url: placesURL).set(ref, LocalPlace(position: 120, at: Date(timeIntervalSince1970: 1_800_000_000)))
    try lock(acksURL)
    try lock(placesURL)
    let acks = AckStore(url: acksURL)
    let places = PlaceStore(url: placesURL)
    XCTAssertNil(acks.ackVersion(ref))
    XCTAssertNil(places.place(ref))
    acks.reload()
    places.reload()
    XCTAssertNil(acks.ackVersion(ref), "still locked: nothing yet")
    try unlock(acksURL)
    try unlock(placesURL)
    acks.reload()
    places.reload()
    XCTAssertEqual(acks.ackVersion(ref), 7)
    XCTAssertEqual(places.place(ref)?.position, 120)
  }
}
