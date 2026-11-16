// A small JSON document on disk: read whole, written whole and atomically. The watch keeps its
// state in Application Support (Storage/Files.swift names the files); the tests use a temp dir.
import Foundation

/// What `JSONFile.load` found.
enum JSONLoad<T> {
  case missing
  case value(T)
  /// There, but it can't be read now: read it again later, and write nothing over it meanwhile.
  case unreadable
  /// It reads but does not decode.
  case corrupt
}

extension CocoaError {
  /// The read failed because there is no file, not because it can't be read now.
  var meansNoFile: Bool { code == .fileReadNoSuchFile || code == .fileNoSuchFile }
}

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

  /// The stored value, nil when there is none or it can't be read (`load` tells them apart).
  func read() -> T? {
    guard case .value(let v) = load() else { return nil }
    return v
  }

  /// What is stored: none, a value, a file that can't be read now (before the watch's first unlock
  /// every file is locked, `completeFileProtectionUntilFirstUserAuthentication`), or one that reads
  /// but does not decode (damaged, or another build's format).
  func load() -> JSONLoad<T> {
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch let e as CocoaError where e.meansNoFile {
      return .missing
    } catch {
      return .unreadable
    }
    guard let value = try? Self.decoder.decode(T.self, from: data) else { return .corrupt }
    return .value(value)
  }

  /// Move the file aside, beside it as `<prefix><uuid>.json`, so the next write never goes over it.
  /// False when it could not be moved.
  @discardableResult
  func moveAside(prefix: String) -> Bool {
    let aside = url.deletingLastPathComponent().appendingPathComponent(prefix + UUID().uuidString + ".json")
    return (try? FileManager.default.moveItem(at: url, to: aside)) != nil
  }

  /// Store `value` (nil removes the file). Readable after the first unlock, so a background
  /// wake on a locked watch can still write. False when it could not be stored.
  @discardableResult
  func write(_ value: T?) -> Bool {
    guard let value else {
      try? FileManager.default.removeItem(at: url)
      return true
    }
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      let data = try Self.encoder.encode(value)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      return true
    } catch {
      // A full disk: the memory copy goes on; the next write tries again.
      return false
    }
  }
}
