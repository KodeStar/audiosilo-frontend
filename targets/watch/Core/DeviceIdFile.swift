// This watch's `device_id` (decision 12): a UUID made once and kept in a file (Storage/Files.swift
// `deviceId`). Before the watch's first unlock the file kept can't be read: that ask gets a
// stand-in, never cached as the id nor written over the file, so the first ask after the unlock
// reads the real one (fe#323; a `static let` would keep the stand-in for the whole launch).
import Foundation

final class DeviceIdFile: @unchecked Sendable {
  let url: URL
  private let lock = NSLock()
  /// The id read or made; nil until then.
  private var known: String?
  /// What an ask gets while the id kept can't be read: the same one each time.
  private lazy var standIn = UUID().uuidString

  init(url: URL) { self.url = url }

  /// The id kept, else (no file yet) a new one, written and kept from then on.
  func read() -> String {
    lock.lock()
    defer { lock.unlock() }
    if let known { return known }
    do {
      if let s = String(data: try Data(contentsOf: url), encoding: .utf8), !s.isEmpty {
        known = s
        return s
      }
    } catch let e as CocoaError where e.meansNoFile {
      // None yet: made below.
    } catch {
      // There, but it can't be read now: the id kept stays this watch's, read at the next ask.
      return standIn
    }
    let id = UUID().uuidString
    try? Data(id.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    known = id
    return id
  }
}
