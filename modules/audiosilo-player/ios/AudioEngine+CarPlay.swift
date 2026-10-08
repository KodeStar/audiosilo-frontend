import Foundation

// What the CarPlay scene (WS-E's files) reads from and asks of the engine. Main thread only,
// like the rest of the engine. The engine exists once JS called `setup` (CarPlay asks JS to
// start every book, so a loaded book always has one): `AudioEngine.shared` is nil before.
//
//   AudioEngine.shared                      the live engine (weak; nil before setup)
//   engine.chapterClips                     the loaded book's chapters ([] = no chapter list)
//   engine.currentClipIndex                 the chapter playing (nil without chapters)
//   engine.clipDuration(i)                  a chapter's length in seconds, when known
//   engine.seekToClip(i)                    jump to a chapter's start (sends onRemoteMove)
//   engine.emitRemoteBookmark()             send onRemoteBookmark at the current place
//   engine.isPlaying / play() / pause()     transport (play/pause count as the listener's)
//   engine.emit(name, body)                 send any module event (onCarConnection, ...)
//   AudioEngine.chaptersDidChange           posted when a book loads or resets, and when the
//                                           chapter playing changes
//   AudioEngine.playbackStateDidChange      posted with every onState (userInfo["state"])
extension AudioEngine {
  static let chaptersDidChange = Notification.Name("app.audiosilo.player.chaptersDidChange")
  static let playbackStateDidChange = Notification.Name("app.audiosilo.player.playbackStateDidChange")

  /// The loaded book's chapters, in book order. Empty with fewer than two (the engine then
  /// plays and shows whole files, and CarPlay has no chapter list to offer).
  var chapterClips: [ChapterClip] { clips.isActive ? clips.clips : [] }

  /// The chapter playing, nil without chapters.
  var currentClipIndex: Int? { nowPlayingClip ?? currentClip() }

  /// A chapter's length in seconds: its bounds, or for a chapter running to its file's end
  /// the file's duration as `load` gave it. nil when that isn't known.
  func clipDuration(_ index: Int) -> Double? {
    guard clips.isActive, clips.clips.indices.contains(index) else { return nil }
    let c = clips.clips[index]
    let fileDuration = tracks.indices.contains(c.fileIndex) ? tracks[c.fileIndex].duration : nil
    guard let end = c.end(fileDuration: fileDuration) else { return nil }
    return end - c.startInFile
  }

  /// Jump to a chapter's start, as a remote move (CarPlay's chapter list): the store lowers
  /// the resume floor when `onRemoteMove` arrives. Doesn't change play/pause.
  func seekToClip(_ index: Int) {
    guard clips.isActive, clips.clips.indices.contains(index) else { return }
    let c = clips.clips[index]
    moveRemotely(to: ClipTarget(fileIndex: c.fileIndex, position: c.startInFile))
  }

  /// CarPlay's bookmark button: `onRemoteBookmark` with the file and position right now (a
  /// pending start seek's target while one is waiting).
  func emitRemoteBookmark() {
    guard !tracks.isEmpty else { return }
    emit("onRemoteBookmark", ["trackIndex": currentIndex, "position": currentPosition()])
  }

  func postChaptersDidChange() {
    NotificationCenter.default.post(name: Self.chaptersDidChange, object: self)
  }
}
