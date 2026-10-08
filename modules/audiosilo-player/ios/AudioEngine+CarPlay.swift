import Foundation

// The engine as the CarPlay templates see it (`CarPlayPlayerAccess`, the access file). Main
// thread only, like the rest of the engine. The engine exists once JS called `setup` (CarPlay
// asks JS to start every book, so a loaded book always has one): `CarPlayPlayer.current` is nil
// before. Already satisfied in AudioEngine.swift: `isPlaying`, `setRateFromRemote(_:)` (the
// rate command's own path, so `onRateChange` fires once) and `emitRemoteBookmark()`.
extension AudioEngine: CarPlayPlayerAccess {
  /// The loaded book's chapter titles, in book order. Empty with fewer than two clips (the
  /// engine then plays and shows whole files, and CarPlay has no chapter list to offer).
  var chapterTitles: [String] { clips.isActive ? clips.clips.map(\.title) : [] }

  /// The chapter playing, nil without chapters.
  var currentChapterIndex: Int? { nowPlayingClip ?? currentClip() }

  var hasLoadedBook: Bool { !tracks.isEmpty }

  /// `load`'s book in the snapshot's item terms (`carItemId` in JS), nil when JS didn't send one
  /// (an older bundle) or sent an incomplete one.
  var loadedBookId: String? {
    guard let b = book, !b.connectionId.isEmpty, !b.path.isEmpty else { return nil }
    return CarItemId.make(connectionId: b.connectionId, libraryId: b.libraryId, path: b.path)
  }

  /// The listener's speed.
  var rate: Double { Double(baseRate) }

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
