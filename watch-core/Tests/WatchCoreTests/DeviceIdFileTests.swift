// The device id read before the watch's first unlock is a stand-in for that ask only (fe#323).
import XCTest

@testable import WatchCore

final class DeviceIdFileTests: XCTestCase {
  func testAnIdThatCantBeReadYetIsReadOnceItCan() throws {
    let dir = try tempDir(self)
    let url = dir.appendingPathComponent("device-id")
    try Data("kept-id".utf8).write(to: url)
    let file = DeviceIdFile(url: url)
    try lock(url)
    let standIn = file.read()
    XCTAssertNotEqual(standIn, "kept-id")
    XCTAssertEqual(file.read(), standIn, "the same stand-in while it can't be read")
    try unlock(url)
    XCTAssertEqual(file.read(), "kept-id", "never kept for the launch")
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "kept-id", "never written over")
  }

  func testAnIdIsMadeOnceAndKept() throws {
    let dir = try tempDir(self)
    let url = dir.appendingPathComponent("device-id")
    let made = DeviceIdFile(url: url).read()
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), made)
    XCTAssertEqual(DeviceIdFile(url: url).read(), made, "the next launch reads it")
    let file = DeviceIdFile(url: url)
    XCTAssertEqual(file.read(), made)
    try FileManager.default.removeItem(at: url)
    XCTAssertEqual(file.read(), made, "read once, it stands for the launch")
  }
}
