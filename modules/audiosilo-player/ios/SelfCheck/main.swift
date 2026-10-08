// Host self-check for the pure Swift parts of the iOS engine (no simulator needed):
//   modules/audiosilo-player/ios/SelfCheck/run.sh
// Compiled with swiftc together with ../ChapterClips.swift and ../VoiceBoostDSP.swift.
// Excluded from the pod (AudiosiloPlayer.podspec `exclude_files`). Exits non-zero on failure.

import AVFoundation
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

// MARK: - VoiceBoostDSP

/// Non-interleaved channels through the DSP in 512-frame calls (the tap's layout: one buffer per
/// channel), or one interleaved buffer when `interleaved`.
func boost(_ input: [[Float]], sampleRate: Double, enabled: Bool = true, interleaved: Bool = false) -> [[Float]] {
  var dsp = VoiceBoostDSP()
  precondition(dsp.prepare(sampleRate: sampleRate, channels: input.count))
  defer { dsp.release() }
  var out = input
  let nch = input.count
  let chunk = 512
  let abl = AudioBufferList.allocate(maximumBuffers: interleaved ? 1 : nch)
  defer { free(abl.unsafeMutablePointer) }
  let scratch = UnsafeMutablePointer<Float>.allocate(capacity: chunk * nch)
  defer { scratch.deallocate() }
  var start = 0
  while start < input[0].count {
    let n = min(chunk, input[0].count - start)
    for c in 0..<nch { for j in 0..<n { scratch[interleaved ? j * nch + c : c * chunk + j] = out[c][start + j] } }
    if interleaved {
      abl[0] = AudioBuffer(mNumberChannels: UInt32(nch), mDataByteSize: UInt32(n * nch * 4), mData: scratch)
    } else {
      for c in 0..<nch { abl[c] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 4), mData: scratch + c * chunk) }
    }
    dsp.render(abl.unsafeMutablePointer, frames: n, enabled: enabled)
    for c in 0..<nch { for j in 0..<n { out[c][start + j] = scratch[interleaved ? j * nch + c : c * chunk + j] } }
    start += n
  }
  return out
}

func dbfs(_ x: Double) -> Double { 20 * log10(max(x, 1e-12)) }

/// RMS over the 50 ms windows where `gate` (the input) is above -50 dBFS: the level of the
/// speech itself, not diluted by its pauses.
func activeRMS(_ x: [[Float]], gate: [[Float]], sampleRate: Double) -> Double {
  let w = Int(sampleRate * 0.05)
  var sum = 0.0, n = 0
  for i in 0..<(x[0].count / w) {
    var g = 0.0, s = 0.0
    for c in 0..<x.count {
      for j in (i * w)..<((i + 1) * w) { g += Double(gate[c][j] * gate[c][j]); s += Double(x[c][j] * x[c][j]) }
    }
    if dbfs(sqrt(g / Double(w * x.count))) > -50 { sum += s; n += w * x.count }
  }
  return sqrt(sum / Double(max(n, 1)))
}

func peakOf(_ x: [[Float]]) -> Float { x.flatMap { $0 }.reduce(0) { max($0, abs($1)) } }

/// A speech-like test signal: a 180 Hz voice with harmonics, in 250 ms "syllables" (raised
/// cosine) with 150 ms gaps, scaled to `peakDb`.
func syllables(seconds: Double, sampleRate: Double, peakDb: Double) -> [Float] {
  let n = Int(seconds * sampleRate)
  var x = [Float](repeating: 0, count: n)
  for i in 0..<n {
    let t = Double(i) / sampleRate
    let phase = t.truncatingRemainder(dividingBy: 0.4)
    guard phase < 0.25 else { continue }
    let env = 0.5 - 0.5 * cos(2 * Double.pi * phase / 0.25)
    let v = sin(2 * Double.pi * 180 * t) + 0.5 * sin(2 * Double.pi * 360 * t) + 0.25 * sin(2 * Double.pi * 720 * t)
    x[i] = Float(env * v / 1.75)
  }
  let g = Float(pow(10, peakDb / 20)) / x.reduce(0) { max($0, abs($1)) }
  return x.map { $0 * g }
}

do {
  let sr = 44_100.0
  let ceiling = Float(pow(10, Double(VoiceBoostPreset.ceilingDb) / 20))
  var fmt = AudioStreamBasicDescription(
    mSampleRate: sr, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
    mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
  check(VoiceBoostDSP.accepts(fmt), "float32 PCM (what AVPlayer hands a tap) is processed")
  fmt.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked
  fmt.mBitsPerChannel = 16
  check(!VoiceBoostDSP.accepts(fmt), "16-bit integer PCM passes through")

  let quiet = syllables(seconds: 3, sampleRate: sr, peakDb: -26)
  let off = boost([quiet, quiet], sampleRate: sr, enabled: false)
  check(off[0] == quiet && off[1] == quiet, "switch off: the audio is untouched, bit for bit")

  let on = boost([quiet, quiet], sampleRate: sr)
  let lift = dbfs(activeRMS(on, gate: [quiet, quiet], sampleRate: sr)) - dbfs(activeRMS([quiet, quiet], gate: [quiet, quiet], sampleRate: sr))
  check(lift > 8, "quiet speech comes up by more than 8 dB: \(lift)")
  check(on[0] == on[1], "a linked detector keeps identical channels identical")

  let loud = syllables(seconds: 3, sampleRate: sr, peakDb: -0.5)
  let limited = boost([loud], sampleRate: sr)
  check(peakOf(limited) <= ceiling + 1e-6, "never above the -1 dBFS ceiling: \(dbfs(Double(peakOf(limited))))")

  let a = boost([quiet, loud], sampleRate: sr)
  let b = boost([quiet, loud], sampleRate: sr, interleaved: true)
  check(a == b, "interleaved and one-buffer-per-channel layouts give the same output")

  // The switch ramps: the first frames after enabling are still mostly dry.
  let ramp = boost([quiet], sampleRate: sr)
  let first = Int(sr * 0.002)
  var maxDiff: Float = 0
  for i in 0..<first { maxDiff = max(maxDiff, abs(ramp[0][i] - quiet[i])) }
  check(maxDiff < 0.2 * peakOf([quiet]), "no jump when switched on (20 ms ramp): \(maxDiff)")

  // A buffer that doesn't match the prepared layout passes through.
  var dsp = VoiceBoostDSP()
  _ = dsp.prepare(sampleRate: sr, channels: 2)
  var mono = Array(quiet.prefix(256))
  let before = mono
  mono.withUnsafeMutableBufferPointer { p in
    var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 256 * 4, mData: p.baseAddress))
    dsp.render(&list, frames: 256, enabled: true)
  }
  dsp.release()
  check(mono == before, "a layout other than the prepared one passes through")
}

// Real speech (macOS `say`), at three levels: the figures the preset is chosen by. Skipped where
// `say` can't run.
do {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("vb-selfcheck-\(getpid())")
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: dir) }
  let file = dir.appendingPathComponent("speech.aiff")
  let say = Process()
  say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
  say.arguments = ["-o", file.path, "The art of war is of vital importance to the State. It is a matter of life and death, a road either to safety or to ruin."]
  if (try? say.run()) != nil, ({ say.waitUntilExit(); return say.terminationStatus == 0 })(),
     let f = try? AVAudioFile(forReading: file),
     let buf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)),
     (try? f.read(into: buf)) != nil, let data = buf.floatChannelData {
    let sr = f.processingFormat.sampleRate
    let speech = Array(UnsafeBufferPointer(start: data[0], count: Int(buf.frameLength)))
    let level = activeRMS([speech], gate: [speech], sampleRate: sr)
    let peak = Double(peakOf([speech]))
    var lifts: [Double] = []
    for target in [-32.0, -22.0, -17.0] {
      let g = Float(min(pow(10, (target - dbfs(level)) / 20), pow(10, -0.5 / 20) / peak))
      let x = speech.map { $0 * g }
      let y = boost([x], sampleRate: sr)
      lifts.append(dbfs(activeRMS(y, gate: [x], sampleRate: sr)) - dbfs(activeRMS([x], gate: [x], sampleRate: sr)))
    }
    print(String(format: "Voice Boost on `say` speech: quiet %+.1f dB, normal %+.1f dB, loud %+.1f dB", lifts[0], lifts[1], lifts[2]))
    check(lifts[0] > 8 && lifts[1] > 6 && lifts[2] > 3, "speech comes up audibly at every level: \(lifts)")
  } else {
    print("(skipped the speech measurement: `say` unavailable)")
  }
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
