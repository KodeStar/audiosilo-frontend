// Host self-check for the pure Swift parts of the iOS engine (no simulator needed):
//   modules/audiosilo-player/ios/SelfCheck/run.sh
// Compiled with swiftc together with ../SmartSpeedPlanner.swift and ../ChapterClips.swift.
// Excluded from the pod (AudiosiloPlayer.podspec `exclude_files`). Exits non-zero on failure.

import Foundation

var failures = 0
var checks = 0

func check(_ cond: @autoclosure () -> Bool, _ what: String, line: Int = #line) {
  checks += 1
  if !cond() {
    failures += 1
    print("FAIL (line \(line)): \(what)")
  }
}

func near(_ a: Double, _ b: Double, _ eps: Double = 1e-6) -> Bool { abs(a - b) <= eps }

// MARK: - SilenceDetector

/// Interleaved stereo PCM: `loud` seconds of a 1000-amplitude square, then `quiet` seconds at
/// amplitude 100 (below the 330 threshold), per segment.
func pcm(_ segments: [(loud: Bool, seconds: Double)], rate: Double, channels: Int = 2) -> [Int16] {
  var out: [Int16] = []
  for s in segments {
    let frames = Int((s.seconds * rate).rounded())
    for f in 0..<frames {
      let v: Int16 = s.loud ? (f % 2 == 0 ? 1000 : -1000) : (f % 2 == 0 ? 100 : -100)
      for _ in 0..<channels { out.append(v) }
    }
  }
  return out
}

do {
  let rate = 1000.0
  let samples = pcm([(true, 1), (false, 0.5), (true, 1), (false, 0.2), (true, 1)], rate: rate)
  var d = SilenceDetector(sampleRate: rate, channels: 2, from: 0)
  let found = samples.withUnsafeBufferPointer { d.consume($0, at: 0) }
  check(found.count == 1, "one silence >= 300 ms (the 200 ms pause is a word gap): \(found)")
  if let s = found.first {
    check(near(s.start, 1.0, 0.002) && near(s.end, 1.5, 0.002), "silence spans 1.0...1.5: \(s)")
  }
  check(d.finish() == nil, "no open run at the end (audio ended loud)")
}

do {
  // A silence straddling two chunks is reported once, whole.
  let rate = 1000.0
  let a = pcm([(true, 1), (false, 0.4)], rate: rate)
  let b = pcm([(false, 0.4), (true, 0.5)], rate: rate)
  var d = SilenceDetector(sampleRate: rate, channels: 2, from: 0)
  let first = a.withUnsafeBufferPointer { d.consume($0, at: 0) }
  check(first.isEmpty, "nothing reported while the run is still open")
  let second = b.withUnsafeBufferPointer { d.consume($0, at: 1.4) }
  check(second.count == 1, "the straddling silence is reported in the second chunk")
  if let s = second.first {
    check(near(s.start, 1.0, 0.002) && near(s.end, 1.8, 0.002), "straddling silence 1.0...1.8: \(s)")
  }
}

do {
  // Overlap from a decoder re-read is skipped, not double-counted.
  let rate = 1000.0
  let a = pcm([(true, 1), (false, 0.5)], rate: rate)
  var d = SilenceDetector(sampleRate: rate, channels: 2, from: 0)
  _ = a.withUnsafeBufferPointer { d.consume($0, at: 0) }
  // Re-read from 1.2 (already seen) through more silence then sound.
  let b = pcm([(false, 0.5), (true, 0.2)], rate: rate)
  let found = b.withUnsafeBufferPointer { d.consume($0, at: 1.2) }
  check(found.count == 1, "overlapped re-read still reports one silence: \(found)")
  if let s = found.first { check(near(s.start, 1.0, 0.002), "start kept from the first read: \(s)") }
}

do {
  // A single loud channel makes the frame loud (peak across channels).
  var samples: [Int16] = []
  for _ in 0..<500 { samples.append(0); samples.append(0) }
  samples.append(0); samples.append(2000)
  for _ in 0..<500 { samples.append(0); samples.append(0) }
  var d = SilenceDetector(sampleRate: 1000, channels: 2, from: 0)
  let found = samples.withUnsafeBufferPointer { d.consume($0, at: 0) }
  check(found.count == 1 && near(found[0].end, 0.5, 0.002), "a loud right channel ends the run: \(found)")
  let tail = d.finish()
  check(tail != nil && near(tail!.start, 0.501, 0.002) && near(tail!.end, 1.001, 0.002), "trailing silence closes at EOF: \(String(describing: tail))")
}

do {
  // Int16.min must not overflow the magnitude check.
  let samples: [Int16] = [Int16.min, Int16.min]
  var d = SilenceDetector(sampleRate: 1000, channels: 2, from: 0)
  _ = samples.withUnsafeBufferPointer { d.consume($0, at: 0) }
  check(d.runStart == nil, "Int16.min is loud")
}

do {
  // A gap in the data closes the run where the data stopped.
  let rate = 1000.0
  var d = SilenceDetector(sampleRate: rate, channels: 2, from: 0)
  let a = pcm([(true, 0.1), (false, 0.5)], rate: rate)
  _ = a.withUnsafeBufferPointer { d.consume($0, at: 0) }
  let b = pcm([(true, 0.1)], rate: rate)
  let found = b.withUnsafeBufferPointer { d.consume($0, at: 5) }
  check(found.count == 1 && near(found[0].end, 0.6, 0.002), "gap closes the run at 0.6: \(found)")
}

// MARK: - SmartSpeedPlanner

do {
  let s = SmartSpeedPlanner.span(for: Silence(start: 10, end: 11))
  check(s != nil && near(s!.start, 10.15) && near(s!.end, 10.8), "1 s silence -> 10.15...10.80 (150 ms kept + 50 ms lead): \(String(describing: s))")
  check(SmartSpeedPlanner.span(for: Silence(start: 0, end: 0.4)) == nil, "a 400 ms silence leaves a 50 ms middle: skipped")
  let ok = SmartSpeedPlanner.span(for: Silence(start: 0, end: 0.45))
  check(ok != nil && near(ok!.end - ok!.start, 0.1), "a 450 ms silence leaves exactly the 100 ms minimum")

  let spans = [BoostSpan(start: 1, end: 2), BoostSpan(start: 5, end: 6), BoostSpan(start: 9, end: 9.5)]
  check(SmartSpeedPlanner.spanIndex(containing: 0.5, in: spans) == nil, "before every span")
  check(SmartSpeedPlanner.spanIndex(containing: 1.5, in: spans) == 0, "inside the first")
  check(SmartSpeedPlanner.spanIndex(containing: 0.99, in: spans) == 0, "a hair early counts (tolerance)")
  check(SmartSpeedPlanner.spanIndex(containing: 2.0, in: spans) == nil, "end is exclusive")
  check(SmartSpeedPlanner.spanIndex(containing: 5.99, in: spans) == 1, "inside the second")
  check(SmartSpeedPlanner.spanIndex(containing: 7, in: spans) == nil, "between spans")
  check(SmartSpeedPlanner.spanIndex(containing: 9.2, in: spans) == 2, "inside the last")
  check(SmartSpeedPlanner.spanIndex(containing: 1, in: []) == nil, "no spans")

  check(SmartSpeedPlanner.boostedRate(base: 1, canPlayFastForward: true) == 3, "1x -> 3x")
  check(SmartSpeedPlanner.boostedRate(base: 2.5, canPlayFastForward: true) == 6, "2.5x caps at 6x")
  check(SmartSpeedPlanner.boostedRate(base: 1, canPlayFastForward: false) == 2, "no fast-forward caps at 2x")
  check(SmartSpeedPlanner.boostedRate(base: 2, canPlayFastForward: false) == nil, "2x without fast-forward: no boost")
  check(SmartSpeedPlanner.boostedRate(base: 5.8, canPlayFastForward: true) == nil, "near the cap: no boost")
  check(SmartSpeedPlanner.boostedRate(base: 0, canPlayFastForward: true) == nil, "paused: no boost")
}

// MARK: - SavedTimeMeter

do {
  var m = SavedTimeMeter()
  // 1x base, 3x boost: 0.9 s of book in 0.3 s of wall saves 0.6 s.
  m.begin(bookTime: 10, wallTime: 100, baseRate: 1, boostedRate: 3)
  let a = m.end(bookTime: 10.9, wallTime: 100.3)
  check(near(a, 0.6, 1e-9), "0.9 s at 3x saves 0.6 s: \(a)")
  // 1.5x base, 4.5x boost: 0.9 s of book in 0.2 s wall; base would cover 0.3 s -> 0.6 saved.
  m.begin(bookTime: 20, wallTime: 200, baseRate: 1.5, boostedRate: 4.5)
  let b = m.end(bookTime: 20.9, wallTime: 200.2)
  check(near(b, 0.6, 1e-9), "speed itself is not counted: \(b)")
  check(near(m.total, 1.2, 1e-9), "total accumulates: \(m.total)")
  // A slow boost (latency) saves less, honestly.
  m.begin(bookTime: 30, wallTime: 300, baseRate: 1, boostedRate: 3)
  let c = m.end(bookTime: 30.9, wallTime: 300.5)
  check(near(c, 0.4, 1e-9), "a late boost saves only what it saved: \(c)")
  // A backwards clock (seek back) adds nothing; the total never goes down.
  let before = m.total
  m.begin(bookTime: 40, wallTime: 400, baseRate: 1, boostedRate: 3)
  check(m.end(bookTime: 39, wallTime: 400.1) == 0 && m.total == before, "a backwards move adds nothing")
  // A missed boundary can't inflate the saving past what 3x could save.
  m.begin(bookTime: 50, wallTime: 500, baseRate: 1, boostedRate: 3)
  let d = m.end(bookTime: 60, wallTime: 500.1)
  check(d <= 10 * (2.0 / 3.0) + 0.011, "clamped to the boost's ceiling: \(d)")
  check(m.end(bookTime: 70, wallTime: 600) == 0, "end without begin adds nothing")
  m.begin(bookTime: 1, wallTime: 1, baseRate: 1, boostedRate: 3)
  m.discard()
  check(!m.isOpen && m.end(bookTime: 5, wallTime: 1.1) == 0, "a discarded span adds nothing")
}

// MARK: - ChapterClips

do {
  // Two files: file 0 has chapters at 0, 100, 250 (last to EOF); file 1 has one chapter (to EOF).
  let clips = ChapterClips([
    ChapterClip(fileIndex: 0, startInFile: 0, endInFile: 100, title: "One"),
    ChapterClip(fileIndex: 0, startInFile: 100, endInFile: 250, title: "Two"),
    ChapterClip(fileIndex: 0, startInFile: 250, endInFile: 0, title: "Three"),
    ChapterClip(fileIndex: 1, startInFile: 0, endInFile: 0, title: "Four"),
  ])
  check(clips.isActive, "4 clips is active")
  check(!ChapterClips([ChapterClip(fileIndex: 0, startInFile: 0, endInFile: 0, title: "x")]).isActive, "1 clip keeps file mode")
  check(!ChapterClips().isActive, "0 clips keeps file mode")

  check(clips.index(fileIndex: 0, position: 0) == 0, "file 0 @0 -> One")
  check(clips.index(fileIndex: 0, position: 99.9) == 0, "file 0 @99.9 -> One")
  check(clips.index(fileIndex: 0, position: 100) == 1, "file 0 @100 -> Two")
  check(clips.index(fileIndex: 0, position: 4000) == 2, "file 0 past every bound -> Three (to EOF)")
  check(clips.index(fileIndex: 1, position: 12) == 3, "file 1 -> Four")
  check(clips.index(fileIndex: 7, position: 0) == nil, "an uncovered file has no clip")

  // Scrubber: chapter-relative to file, clamped inside the clip.
  check(clips.filePosition(clip: 1, chapterTime: 30, fileDuration: 400) == ClipTarget(fileIndex: 0, position: 130), "Two +30 -> 130")
  check(clips.filePosition(clip: 1, chapterTime: 500, fileDuration: 400) == ClipTarget(fileIndex: 0, position: 249.999), "clamped inside Two")
  check(clips.filePosition(clip: 2, chapterTime: 500, fileDuration: 400) == ClipTarget(fileIndex: 0, position: 399.999), "a to-EOF clip clamps to the file end")
  check(clips.filePosition(clip: 2, chapterTime: 500, fileDuration: nil) == ClipTarget(fileIndex: 0, position: 750), "unknown file end: unclamped")
  check(clips.filePosition(clip: 0, chapterTime: -5, fileDuration: 400) == ClipTarget(fileIndex: 0, position: 0), "negative clamps to the clip start")

  // Next / previous.
  check(clips.next(from: 0) == ClipTarget(fileIndex: 0, position: 100), "next from One -> Two")
  check(clips.next(from: 2) == ClipTarget(fileIndex: 1, position: 0), "next from Three crosses into file 1")
  check(clips.next(from: 3) == nil, "next at the last chapter is a no-op")
  check(clips.previous(from: 1, position: 104) == ClipTarget(fileIndex: 0, position: 100), "previous > 3 s in restarts Two")
  check(clips.previous(from: 1, position: 102) == ClipTarget(fileIndex: 0, position: 0), "previous <= 3 s in goes to One")
  check(clips.previous(from: 3, position: 1) == ClipTarget(fileIndex: 0, position: 250), "previous crosses back into file 0")
  check(clips.previous(from: 0, position: 1) == ClipTarget(fileIndex: 0, position: 0), "previous at the first chapter restarts it")

  // Now Playing times.
  let t1 = clips.nowPlayingTimes(clip: 1, position: 130, fileDuration: 400)
  check(near(t1.elapsed, 30) && t1.duration == 150, "Two: 30 of 150: \(t1)")
  let t2 = clips.nowPlayingTimes(clip: 2, position: 300, fileDuration: 400)
  check(near(t2.elapsed, 50) && t2.duration == 150, "Three to EOF: 50 of 150: \(t2)")
  let t3 = clips.nowPlayingTimes(clip: 2, position: 300, fileDuration: nil)
  check(near(t3.elapsed, 50) && t3.duration == nil, "Three, file end unknown: no duration yet")
}

print("\(checks - failures)/\(checks) checks passed")
if failures > 0 { exit(1) }
