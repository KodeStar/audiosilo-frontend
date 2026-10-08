// Smart Speed's pure part: silence detection over decoded PCM, the boost-span plan and the
// time-saved maths. No AVFoundation here on purpose: `SelfCheck/` compiles this file on the host
// with `swiftc` and checks it (see SelfCheck/run.sh). The AVFoundation side (the AVAssetReader
// look-ahead, the boundary observers, the rate changes) is `SmartSpeed.swift`.
//
// Why a rate boost rather than dropping frames (Android's way): an MTAudioProcessingTap cannot
// drop frames, and a rate raised AFTER a tap hears the silence starts late and lands on the next
// word. So silences are found AHEAD of the playhead on the local file, and the player's rate is
// raised only inside the middle of each known silence.

/// A run of near-silence within one file, in seconds of that file.
struct Silence: Equatable {
  var start: Double
  var end: Double
  var length: Double { end - start }
}

/// The part of a silence played boosted, in seconds of the file.
struct BoostSpan: Equatable {
  var start: Double
  var end: Double
}

/// The rules, matched to Android's NarrationSilenceProcessor where they overlap.
enum SmartSpeedRules {
  /// A frame is silent when every channel's sample magnitude is at most this (16-bit PCM).
  /// 330 / 32768 is about -40 dBFS peak, Android's threshold.
  static let thresholdPeak: Int32 = 330
  /// Shorter runs are a pause between words, not a silence (Android: 300 ms).
  static let minSilence: Double = 0.3
  /// Kept at the base rate on each side of every silence, so word edges are never touched
  /// (Android keeps 150 ms each side).
  static let edgeKeep: Double = 0.15
  /// The restore boundary fires this much EARLIER than `end - edgeKeep`. A boundary observer
  /// runs on the main queue, and while boosted every millisecond of callback latency is three
  /// milliseconds of book: 50 ms keeps the 150 ms edge intact through a busy main thread.
  static let restoreLead: Double = 0.05
  /// A boosted middle shorter than this saves under 70 ms and costs two rate changes: skip it.
  static let minSpan: Double = 0.1
  /// Boost = base x 3, capped.
  static let boostFactor: Float = 3
  /// `.timeDomain` time-pitch handles 1/32...32, but speech-quality stretching past 6x buys
  /// nothing during a silence and risks a glitch at the next word.
  static let maxRate: Float = 6
  /// AVPlayer refuses rates above 2 on an item whose `canPlayFastForward` is false.
  static let maxRateWithoutFastForward: Float = 2
}

/// Streams decoded 16-bit interleaved PCM and reports each silence once it has ended. A value
/// type: the look-ahead copies it to a background queue, feeds a chunk and hands the updated
/// copy back, so a chunk read continues exactly where the last one stopped (a silence that
/// straddles two chunks is reported once, whole).
struct SilenceDetector {
  let sampleRate: Double
  let channels: Int
  let threshold: Int32
  let minSilence: Double
  /// Where the open silent run started, nil while sound is playing.
  private(set) var runStart: Double?
  /// File time just after the last consumed frame.
  private(set) var processedUntil: Double

  init(sampleRate: Double, channels: Int, from start: Double,
       threshold: Int32 = SmartSpeedRules.thresholdPeak,
       minSilence: Double = SmartSpeedRules.minSilence) {
    self.sampleRate = max(1, sampleRate)
    self.channels = max(1, channels)
    self.threshold = threshold
    self.minSilence = minSilence
    self.processedUntil = start
  }

  /// Feed interleaved frames starting at file time `startTime`. Frames before `processedUntil`
  /// (a decoder's overlap when a read starts mid-file) are skipped. A gap in the data (a
  /// buffer starting well after the last one ended) closes the open run where data stopped:
  /// nothing is claimed about audio that was never seen.
  mutating func consume(_ samples: UnsafeBufferPointer<Int16>, at startTime: Double) -> [Silence] {
    var found: [Silence] = []
    let frames = samples.count / channels
    guard frames > 0 else { return found }
    if startTime > processedUntil + 0.05 {
      if let rs = runStart, processedUntil - rs >= minSilence {
        found.append(Silence(start: rs, end: processedUntil))
      }
      runStart = nil
    }
    let frameDuration = 1 / sampleRate
    for f in 0..<frames {
      let t = startTime + Double(f) * frameDuration
      if t + frameDuration * 0.5 < processedUntil { continue }
      var loud = false
      let base = f * channels
      for c in 0..<channels where abs(Int32(samples[base + c])) > threshold {
        loud = true
        break
      }
      if loud {
        if let rs = runStart, t - rs >= minSilence { found.append(Silence(start: rs, end: t)) }
        runStart = nil
      } else if runStart == nil {
        runStart = t
      }
    }
    processedUntil = max(processedUntil, startTime + Double(frames) * frameDuration)
    return found
  }

  /// The file ended: close the open run (a trailing silence ends at the file's end).
  mutating func finish() -> Silence? {
    defer { runStart = nil }
    guard let rs = runStart, processedUntil - rs >= minSilence else { return nil }
    return Silence(start: rs, end: processedUntil)
  }
}

enum SmartSpeedPlanner {
  /// The boosted middle of a silence: `edgeKeep` kept on each side, the restore `restoreLead`
  /// earlier still. nil when what is left is too short to be worth two rate changes.
  static func span(for s: Silence) -> BoostSpan? {
    let start = s.start + SmartSpeedRules.edgeKeep
    let end = s.end - SmartSpeedRules.edgeKeep - SmartSpeedRules.restoreLead
    guard end - start >= SmartSpeedRules.minSpan else { return nil }
    return BoostSpan(start: start, end: end)
  }

  static func spans(_ silences: [Silence]) -> [BoostSpan] {
    silences.compactMap(span(for:))
  }

  /// The span containing file time `t` (start inclusive, end exclusive), by binary search over
  /// spans sorted by start (the detector reports them in order). `tolerance` widens the start
  /// so a boundary callback that reads the clock a hair before the boundary still counts.
  static func spanIndex(containing t: Double, in spans: [BoostSpan], tolerance: Double = 0.02) -> Int? {
    var lo = 0
    var hi = spans.count
    while lo < hi {
      let mid = (lo + hi) / 2
      if spans[mid].start - tolerance <= t { lo = mid + 1 } else { hi = mid }
    }
    let i = lo - 1
    guard i >= 0, t < spans[i].end else { return nil }
    return i
  }

  /// The boosted rate for a base rate, or nil when the cap leaves no real boost (a base of 2x
  /// or more on an item that can't fast-forward, or a base already near the cap).
  static func boostedRate(base: Float, canPlayFastForward: Bool) -> Float? {
    guard base > 0 else { return nil }
    let cap = canPlayFastForward ? SmartSpeedRules.maxRate : SmartSpeedRules.maxRateWithoutFastForward
    let boosted = min(base * SmartSpeedRules.boostFactor, cap)
    return boosted > base * 1.1 ? boosted : nil
  }
}

/// Book seconds saved, measured per boosted span: the book time the span covered minus what
/// the base rate would have covered in the same wall time. Decision 8's "time saved at 1x":
/// speed itself is never counted. The total only ever grows.
struct SavedTimeMeter {
  private(set) var total: Double = 0
  private var open: (book: Double, wall: Double, base: Double, boosted: Double)?

  var isOpen: Bool { open != nil }

  mutating func begin(bookTime: Double, wallTime: Double, baseRate: Float, boostedRate: Float) {
    open = (bookTime, wallTime, Double(baseRate), Double(boostedRate))
  }

  /// Close the open span and add its saving; returns what it added. The saving is clamped to
  /// what the boost could possibly have saved over that much book (a little slack for clock
  /// jitter), so a clock read after a missed boundary can't inflate it, and never negative.
  @discardableResult
  mutating func end(bookTime: Double, wallTime: Double) -> Double {
    guard let o = open else { return 0 }
    open = nil
    let book = bookTime - o.book
    let wall = wallTime - o.wall
    guard book > 0, wall >= 0, book.isFinite, wall.isFinite else { return 0 }
    let ceiling = book * max(0, 1 - o.base / o.boosted) + 0.01
    let saved = min(max(0, book - wall * o.base), ceiling)
    total += saved
    return saved
  }

  /// Drop an open span without counting it (the clock it started on is gone).
  mutating func discard() { open = nil }
}
