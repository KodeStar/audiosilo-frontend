import Foundation

/// What the CarPlay templates need from the playback engine (Phase 6, the WS-B -> WS-E seam).
/// The engine conforms to this; `CarPlayPlayer.current` returns the shared engine. All members
/// are read and called on the main thread (CarPlay templates and AVFoundation both live there).
protocol CarPlayPlayerAccess: AnyObject {
  /// Titles of the loaded book's chapter clips, in order (the `chapters` `load` received).
  /// Empty for 0/1 clips or nothing loaded.
  var chapterTitles: [String] { get }
  /// Index into `chapterTitles` of the chapter playing now, nil when there are no clips.
  var currentChapterIndex: Int? { get }
  /// A book is loaded (playing or paused).
  var hasLoadedBook: Bool { get }
  /// Playing, or about to (a pending start counts).
  var isPlaying: Bool { get }
  /// The loaded book as a car item id (`CarItemId.make` over `load`'s `book` argument), nil
  /// when unknown. Drives the "playing" indicator in the lists and ends a tap's spinner.
  var loadedBookId: String? { get }
  /// The base playback rate (the listener's speed).
  var rate: Double { get }
  /// Seek to the start of a chapter clip (across files when needed); emits `onRemoteMove`
  /// once the seek has landed.
  func seekToChapter(_ index: Int)
  /// Apply a rate chosen in the car; emits `onRateChange` (the store persists it).
  func setRateFromRemote(_ rate: Double)
  /// Emit `onRemoteBookmark` at the current place.
  func emitRemoteBookmark()
}

extension Notification.Name {
  /// Posted by the engine on the main thread when the loaded book, the play state or the
  /// current chapter changes. The CarPlay templates refresh on it.
  static let audiosiloPlayerDidChange = Notification.Name("AudiosiloPlayerDidChange")
}
