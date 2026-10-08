// Pure chapter-clip maths for the iOS lock screen (Now Playing) and CarPlay's chapter list.
// No AVFoundation / MediaPlayer here on purpose: `SelfCheck/` compiles this file on the host
// with `swiftc` and checks it (see SelfCheck/run.sh).

/// One chapter as the shared bridge sends it to `load` (`buildChapterClips` in
/// `book-queue.ts`): a span of ONE file. `endInFile <= startInFile` (the bridge sends 0 for a
/// file's last chapter) means "to the end of the file".
struct ChapterClip: Equatable {
  var fileIndex: Int
  var startInFile: Double
  var endInFile: Double
  var title: String

  /// Whether the clip runs to its file's end (the bridge's `endInFile <= 0` convention).
  var runsToFileEnd: Bool { endInFile <= startInFile }

  /// The clip's end within its file, given that file's duration when it is known.
  func end(fileDuration: Double?) -> Double? {
    if !runsToFileEnd { return endInFile }
    guard let d = fileDuration, d.isFinite, d > startInFile else { return nil }
    return d
  }
}

/// Where a lock-screen chapter command should take the engine. `sameFile` targets are a plain
/// seek; the others rebuild the queue through `skip(to:position:)`, which owns the
/// seek-before-ready deferral.
struct ClipTarget: Equatable {
  var fileIndex: Int
  var position: Double
}

/// The chapter clips of the loaded book. With fewer than two clips the engine keeps its
/// whole-file behaviour (whole-file Now Playing, next/previous FILE), so `isActive` gates
/// every chapter path: that is the "0/1 clips = today's behaviour" rule.
struct ChapterClips {
  let clips: [ChapterClip]

  /// `previousTrackCommand` restarts the current chapter when the listener is more than this
  /// far into it (Media3's `seekToPrevious` rule, which the Android lock screen follows).
  static let restartThreshold: Double = 3

  init(_ clips: [ChapterClip] = []) {
    self.clips = clips
  }

  var isActive: Bool { clips.count >= 2 }
  var count: Int { clips.count }

  /// The clip index for a FILE position. Mirrors Android's `ChapterMap.fileToItem`: the clip
  /// of that file containing the position, else the latest clip of the file starting at or
  /// before it, else the file's first clip (a position before every clip). nil when no clip
  /// covers that file at all (the bridge never sends that: `buildChapterClips` covers every
  /// file or sends none).
  func index(fileIndex: Int, position: Double) -> Int? {
    var candidate: Int?
    for (i, c) in clips.enumerated() where c.fileIndex == fileIndex {
      let end = c.runsToFileEnd ? Double.greatestFiniteMagnitude : c.endInFile
      if position >= c.startInFile && position < end { return i }
      if candidate == nil || c.startInFile <= position { candidate = i }
    }
    return candidate
  }

  /// Chapter-relative scrubber time (`MPChangePlaybackPositionCommandEvent.positionTime`) to a
  /// file position, clamped inside the clip so a drag to the far end can't land in the next
  /// chapter (one millisecond short of a bounded clip's end).
  func filePosition(clip i: Int, chapterTime t: Double, fileDuration: Double?) -> ClipTarget? {
    guard clips.indices.contains(i) else { return nil }
    let c = clips[i]
    var p = c.startInFile + max(0, t.isFinite ? t : 0)
    if let end = c.end(fileDuration: fileDuration) {
      p = min(p, max(c.startInFile, end - 0.001))
    }
    return ClipTarget(fileIndex: c.fileIndex, position: p)
  }

  /// `nextTrackCommand`: the next clip's start, or nil at the last clip (a no-op, like the
  /// Android lock screen with its next button disabled on the last chapter).
  func next(from i: Int) -> ClipTarget? {
    guard i + 1 < clips.count, i >= 0 else { return nil }
    let c = clips[i + 1]
    return ClipTarget(fileIndex: c.fileIndex, position: c.startInFile)
  }

  /// `previousTrackCommand`: the current clip's start when more than `restartThreshold` into it,
  /// else the previous clip's start; at the first clip, its own start.
  func previous(from i: Int, position: Double) -> ClipTarget? {
    guard clips.indices.contains(i) else { return nil }
    let c = clips[i]
    if position - c.startInFile > Self.restartThreshold || i == 0 {
      return ClipTarget(fileIndex: c.fileIndex, position: c.startInFile)
    }
    let p = clips[i - 1]
    return ClipTarget(fileIndex: p.fileIndex, position: p.startInFile)
  }

  /// Chapter-relative elapsed + duration for Now Playing. The duration needs the file's
  /// duration only for a clip that runs to its file's end; nil when that is still unknown.
  func nowPlayingTimes(clip i: Int, position: Double, fileDuration: Double?) -> (elapsed: Double, duration: Double?) {
    guard clips.indices.contains(i) else { return (position, fileDuration) }
    let c = clips[i]
    let elapsed = max(0, position - c.startInFile)
    guard let end = c.end(fileDuration: fileDuration) else { return (elapsed, nil) }
    return (min(elapsed, end - c.startInFile), end - c.startInFile)
  }
}
