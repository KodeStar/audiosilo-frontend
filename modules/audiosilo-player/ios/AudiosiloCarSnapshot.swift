import Foundation

// MARK: - Model

/// The car snapshot JS writes through `setCarSnapshot` (Phase 6 contract, section 3). Native
/// has no strings of its own: every label comes from here, localized by JS. Decoding is
/// lenient (a missing field never drops the whole snapshot; undeclared keys are ignored, so
/// only what iOS reads is declared); `play` is Android's and ignored here (iOS always lets JS
/// start a book).
struct CarSnapshot: Decodable {
  /// The labels the CarPlay templates show (JS sends more; the rest are Android's).
  struct Labels: Decodable {
    var `continue`: String?
    var chapters: String?
    var empty: String?
    var signedOut: String?
  }

  /// Which book an item is: the engine's loaded book compares against it (`loadedBook`) for
  /// the "playing" indicator and the end of a tapped book's spinner.
  struct Book: Decodable, Hashable {
    var connectionId: String
    var libraryId: Int
    var path: String
  }

  struct Item: Decodable {
    /// Opaque to iOS: sent back to JS in `onCarPlayRequest`.
    var id: String
    var title: String
    var subtitle: String?
    var progress: Double?
    var finished: Bool?
    var artwork: String?
    /// Absent from a snapshot an older bundle wrote (still on disk at a CarPlay-first launch):
    /// then no item shows as playing until JS writes the next one.
    var book: Book?
  }

  struct Tab: Decodable {
    var id: String
    var title: String
    var items: [Item]
  }

  var version: Int?
  var labels: Labels
  var signedIn: Bool
  var tabs: [Tab]
}

// MARK: - Store

/// Keeps the last car snapshot in memory and on disk (Application Support), so a CarPlay
/// connection shows the lists at once, before (or without) JS writing a fresh one. The file is
/// written with `completeUntilFirstUserAuthentication` protection: CarPlay must work with the
/// phone locked. Main thread for reads of `snapshot`; `set(json:)` may be called from any thread.
final class AudiosiloCarSnapshotStore {
  static let shared = AudiosiloCarSnapshotStore()
  /// Posted on the main thread after a new snapshot replaced the current one.
  static let didChange = Notification.Name("AudiosiloCarSnapshotDidChange")

  private(set) var snapshot: CarSnapshot?
  private var loadedFromDisk = false
  private let io = DispatchQueue(label: "audiosilo.car-snapshot")

  private static var fileURL: URL? {
    guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    return base.appendingPathComponent("AudioSilo", isDirectory: true)
      .appendingPathComponent("car-snapshot.json")
  }

  /// From `setCarSnapshot`. Decodes off the main thread, publishes on main, then writes the
  /// file. A snapshot that fails to decode is dropped (the previous one stays).
  func set(json: String) {
    io.async {
      guard let data = json.data(using: .utf8),
            let decoded = try? JSONDecoder().decode(CarSnapshot.self, from: data) else {
        NSLog("[AudiosiloCar] ignoring a car snapshot that does not decode")
        return
      }
      DispatchQueue.main.async {
        self.snapshot = decoded
        self.loadedFromDisk = true // memory is newer than any file
        NotificationCenter.default.post(name: Self.didChange, object: nil)
      }
      Self.write(data)
    }
  }

  /// At CarPlay connect: the last snapshot from disk when this process has none yet. Small
  /// file, read synchronously so the first template already has the lists. Main thread.
  func loadIfNeeded() {
    guard snapshot == nil, !loadedFromDisk else { return }
    loadedFromDisk = true
    guard let url = Self.fileURL,
          let data = try? Data(contentsOf: url),
          let decoded = try? JSONDecoder().decode(CarSnapshot.self, from: data) else { return }
    snapshot = decoded
  }

  private static func write(_ data: Data) {
    guard let url = fileURL else { return }
    do {
      var dir = url.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      // Rebuilt by the app at every launch: keep it out of backups.
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? dir.setResourceValues(values)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      NSLog("[AudiosiloCar] could not save the car snapshot: \(error)")
    }
  }
}

// MARK: - Events

/// Car events (`onCarConnection`, `onCarPlayRequest`) queued until JS listens. The car can
/// connect, or a book be tapped, before JS has registered its listeners (a CarPlay-first cold
/// launch boots JS only then), and an Expo module event sent with no listener is lost. The module
/// reports listeners through `OnStartObserving` / `OnStopObserving`; until then only the LAST
/// event of each name is kept (a later connect state or tap supersedes an earlier one).
/// Main thread only.
final class AudiosiloCarEvents {
  static let shared = AudiosiloCarEvents()

  /// Weak: a JS reload creates a new module; events for the old one queue until the new one
  /// observes.
  private weak var module: AudiosiloPlayerModule?
  private var observing = Set<String>()
  private var pending: [String: [String: Any]] = [:]

  func startObserving(_ name: String, module: AudiosiloPlayerModule) {
    onMain {
      if self.module !== module {
        self.module = module
        self.observing.removeAll()
      }
      self.observing.insert(name)
      if let body = self.pending.removeValue(forKey: name) {
        module.sendEvent(name, body)
      }
    }
  }

  func stopObserving(_ name: String, module: AudiosiloPlayerModule) {
    onMain {
      guard self.module === module else { return }
      self.observing.remove(name)
    }
  }

  func send(_ name: String, _ body: [String: Any]) {
    onMain {
      if let module = self.module, self.observing.contains(name) {
        module.sendEvent(name, body)
      } else {
        self.pending[name] = body
      }
    }
  }
}
