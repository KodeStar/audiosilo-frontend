// A small JSON document on disk: read whole, written whole and atomically. The watch keeps its
// state in Application Support (Storage/Files.swift names the files); the tests use a temp dir.
import Foundation

struct JSONFile<T: Codable> {
  let url: URL

  private static var encoder: JSONEncoder {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .millisecondsSince1970
    return e
  }

  private static var decoder: JSONDecoder {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .millisecondsSince1970
    return d
  }

  /// The stored value, nil when there is none or it can't be read.
  func read() -> T? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? Self.decoder.decode(T.self, from: data)
  }

  /// Store `value` (nil removes the file). Readable after the first unlock, so a background
  /// wake on a locked watch can still write.
  func write(_ value: T?) {
    guard let value else {
      try? FileManager.default.removeItem(at: url)
      return
    }
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      let data = try Self.encoder.encode(value)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      // A full disk: the memory copy goes on; the next write tries again.
    }
  }
}
