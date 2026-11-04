// Where the watch keeps everything but the token: Application Support/AudioSilo. The
// downloads are excluded from backup; every file is readable after the first unlock
// (`JSONFile`), so a background wake on a locked watch can write.
//
//   account.json       the signed-in account (no token: Keychain.swift)
//   device-id          this watch's device_id, a UUID made once (decision 12)
//   server.json        the server's last /server answer (the gate, offline)
//   acks.json          acknowledged versions + answered offers (AckStore)
//   outbox.json        events waiting (Outbox)
//   sync-state.json    last sync, couldn't-sync list, clock skew (Outbox)
//   open-span.json     the span being played (SpanRecorder, pass 2's player)
//   downloads.json     the books on this watch (DownloadManager)
//   items/             each book's item + chapters, kept for offline playback
//   downloads/<id>/    each book's rendition files
import Foundation

enum Files {
  static let root: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("AudioSilo", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  static var account: URL { root.appendingPathComponent("account.json") }
  static var server: URL { root.appendingPathComponent("server.json") }
  static var acks: URL { root.appendingPathComponent("acks.json") }
  static var openSpan: URL { root.appendingPathComponent("open-span.json") }
  static var downloadsIndex: URL { root.appendingPathComponent("downloads.json") }
  static var items: URL { root.appendingPathComponent("items", isDirectory: true) }

  /// The books' audio, excluded from backup.
  static let downloads: URL = {
    var dir = root.appendingPathComponent("downloads", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? dir.setResourceValues(values)
    return dir
  }()

  /// This watch's `device_id`, made once and kept.
  static let deviceId: String = {
    let url = root.appendingPathComponent("device-id")
    if let s = try? String(contentsOf: url, encoding: .utf8), !s.isEmpty { return s }
    let id = UUID().uuidString
    try? Data(id.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    return id
  }()

  /// A book's item cache file.
  static func item(_ ref: BookRef) -> URL {
    items.appendingPathComponent("\(safeName(ref.key)).json")
  }

  /// A file name for any string: its letters and digits (the last 60), plus an FNV-1a hash.
  static func safeName(_ s: String) -> String {
    var h: UInt64 = 1469598103934665603
    for b in s.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
    let readable = s.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? String($0) : "_" }.joined()
    return String(readable.suffix(60)) + "-" + String(h, radix: 16)
  }

  /// Free space on the watch's volume (bytes), nil when unknown. watchOS has no
  /// "important usage" figure (that key is unavailable there), so this is the plain free space.
  static func freeBytes() -> Int64? {
    let attrs = try? FileManager.default.attributesOfFileSystem(forPath: root.path)
    return (attrs?[.systemFreeSize] as? NSNumber)?.int64Value
  }

  /// A file's or folder's size on disk (bytes).
  static func size(of url: URL) -> Int64 {
    let fm = FileManager.default
    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else { return 0 }
    if !isDir.boolValue {
      return (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
    }
    let files = (try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.fileSizeKey])) ?? []
    return files.reduce(0) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
  }
}

/// The open span kept in `open-span.json` (SpanRecorder's store).
final class FileSpanStore: OpenSpanStore {
  private let file = JSONFile<OpenSpan>(url: Files.openSpan)
  func load() -> OpenSpan? { file.read() }
  func save(_ span: OpenSpan?) { file.write(span) }
}
