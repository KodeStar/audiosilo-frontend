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

  func testAnIdThatCantBeWrittenYetIsTheSameOneUntilItIs() throws {
    let dir = try tempDir(self).appendingPathComponent("locked", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("device-id")
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path) }
    try XCTSkipIf(FileManager.default.isWritableFile(atPath: dir.path), "permissions are not enforced here")
    let file = DeviceIdFile(url: url)
    let made = file.read()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    XCTAssertEqual(file.read(), made, "the same one while it can't be written")
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
    XCTAssertEqual(file.read(), made)
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), made, "the id used is the one kept")
    XCTAssertEqual(DeviceIdFile(url: url).read(), made, "the next launch reads it")
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
