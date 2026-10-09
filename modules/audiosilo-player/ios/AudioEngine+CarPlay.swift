import Foundation

extension Notification.Name {
  /// Posted by the engine on the main thread (`AudioEngine.postPlayerDidChange`) with every
  /// `onState` (which covers a load and a reset) and when the chapter Now Playing shows changes.
  /// The CarPlay templates refresh on it, reading the state back from `AudioEngine.shared`.
  static let audiosiloPlayerDidChange = Notification.Name("AudiosiloPlayerDidChange")
}

// What the CarPlay templates read from the engine (AudiosiloCarPlaySceneDelegate.swift, through
// `AudioEngine.shared`). Main thread only, like the rest of the engine. The engine exists once JS
// called `setup` (CarPlay asks JS to start every book, so a loaded book always has one).
// Also used from there: `isPlaying`, `rate`, `setRateFromRemote(_:)` (the rate command's own
// path, so `onRateChange` fires once) and `emitRemoteBookmark()`.
extension AudioEngine {
  /// How many chapters CarPlay can list: 0 with fewer than two clips (the engine then plays and
  /// shows whole files, and CarPlay has no chapter list to offer).
  var chapterCount: Int { clips.isActive ? clips.count : 0 }

  /// The loaded book's chapter titles, in book order. Empty when `chapterCount` is 0.
  var chapterTitles: [String] { clips.isActive ? clips.clips.map(\.title) : [] }

  /// The chapter playing, nil without chapters.
  var currentChapterIndex: Int? { nowPlayingClip ?? currentClip() }

  var hasLoadedBook: Bool { !tracks.isEmpty }

  /// `load`'s book in the snapshot's terms (a car item's `book`), nil when JS didn't send one
  /// (an older bundle) or sent an incomplete one.
  var loadedBook: CarSnapshot.Book? {
    guard let b = book, !b.connectionId.isEmpty, !b.path.isEmpty else { return nil }
    return CarSnapshot.Book(connectionId: b.connectionId, libraryId: b.libraryId, path: b.path)
  }

  /// Jump to a chapter's start, as a remote move (CarPlay's chapter list): the store lowers
  /// the resume floor when `onRemoteMove` arrives. Doesn't change play/pause.
  func seekToChapter(_ index: Int) {
    guard clips.isActive, clips.clips.indices.contains(index) else { return }
    let c = clips.clips[index]
    moveRemotely(to: ClipTarget(fileIndex: c.fileIndex, position: c.startInFile))
  }

  /// `.audiosiloPlayerDidChange` on the main thread, async: callers are in the middle of
  /// updating state (Now Playing, a load), and the CarPlay side reads the engine back.
  static func postPlayerDidChange() {
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: .audiosiloPlayerDidChange, object: nil)
    }
  }
}
