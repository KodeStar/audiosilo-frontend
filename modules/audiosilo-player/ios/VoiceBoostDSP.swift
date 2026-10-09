import CoreAudio
import Foundation

// Voice boost's per-sample DSP, kept free of AVFoundation so the host self-check
// (SelfCheck/run.sh) runs the exact code the tap runs on real speech. VoiceBoostTap.swift owns
// the MTAudioProcessingTap around it.
//
// The chain: an 80 Hz one-pole high-pass, a soft-knee compressor (linked across channels so the
// voice's stereo image doesn't move), make-up gain, then a peak limiter at the ceiling. The same
// numbers as Android's VoiceBoostProcessor, so the two platforms sound alike.
//
// Real-time rules (`render` runs on the audio render thread): no allocation, no locks, no Swift
// reference counting. The struct holds only numbers and one raw pointer (allocated in `prepare`,
// freed in `release`, both called outside the render thread), so the render path touches no
// Swift object.

/// The preset (raised after the iPhone Air test). The same numbers as Android's
/// VoiceBoostProcessor.
///
/// Why these: the detector is per-sample PEAK, so a curve's unity point (where the make-up and
/// the gain reduction cancel) is threshold + makeup * ratio / (ratio - 1). The first preset
/// (-24 dBFS / +6 dB, unity -15 dBFS) and the next one tried (-30 / +9, unity -16.5) both sat
/// below narration's peaks, so the compressor took back the make-up: measured on real speech,
/// normal narration came up only ~1 dB and loud passages went DOWN, which is what the device
/// test heard ("no difference"). This one's unity point is -2 dBFS. Measured on the Mac through
/// this code (a LibriVox mp3 and `say` speech, active-speech RMS): quiet (-32 dBFS) +10 to
/// +11.5 dB, normal (-22 to -25) +8.2 to +8.7 dB, loud (-17) +4.9 dB, peaks held at the
/// -1 dBFS ceiling (the limiter works on most syllable peaks).
enum VoiceBoostPreset {
  static let thresholdDb: Float = -20
  static let ratio: Float = 3
  static let kneeDb: Float = 6
  static let attackSeconds: Float = 0.010
  static let releaseSeconds: Float = 0.200
  static let makeupDb: Float = 12
  static let ceilingDb: Float = -1
  static let highPassHz: Float = 80
  /// The dry/processed crossfade when the switch flips (a hard switch clicks).
  static let rampSeconds: Float = 0.020
  static let limiterReleaseSeconds: Float = 0.050
}

struct VoiceBoostDSP {
  /// False until `prepare` accepted a format; `render` then passes the audio through.
  private(set) var ready = false
  private(set) var channels = 0
  /// Two floats per channel for the high-pass: previous input, previous output.
  private var hp: UnsafeMutablePointer<Float>?
  private var hpCoef: Float = 0
  /// Dry/processed mix (0 = dry), ramped toward the switch.
  private(set) var mix: Float = 0
  private var mixStep: Float = 0
  /// Compressor gain change (dB, <= 0), smoothed.
  private var gainDb: Float = 0
  private var attackCoef: Float = 0
  private var releaseCoef: Float = 0
  /// Limiter gain (linear, <= 1): instant attack, smoothed release.
  private var limGain: Float = 1
  private var limReleaseCoef: Float = 0
  /// The linear compressor + make-up gain and the `gainDb` it was computed at: `powf` runs only
  /// when the smoothed gain moved by more than `gainEpsilonDb` since (between syllables and in
  /// steady speech it barely moves), so the gain applied is never more than that off.
  private var gain: Float = 1
  private var gainAtDb: Float = .infinity
  // The preset, copied in `prepare`: reading a Swift static from the render thread can run its
  // lazy initialiser (swift_once, a lock) the first time.
  private var thresholdDb: Float = 0
  private var kneeDb: Float = 1
  private var slope: Float = 0
  private var makeupDb: Float = 0
  private var ceiling: Float = 1
  /// The knee's lower edge as a linear peak: below it the compressor wants 0 dB, so the
  /// per-sample `log10f` is skipped.
  private var kneeStart: Float = 0
  /// How far the smoothed gain may move before `powf` recomputes the linear gain (dB). An
  /// instance constant, not a static, for the same render-thread reason as the preset copies.
  private let gainEpsilonDb: Float = 0.01

  /// The only sample format `render` processes: 32-bit float linear PCM (what an
  /// MTAudioProcessingTap gets from AVPlayer for AAC, MP3 and every other decoded source).
  static func accepts(_ asbd: AudioStreamBasicDescription) -> Bool {
    asbd.mFormatID == kAudioFormatLinearPCM
      && (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
      && asbd.mBitsPerChannel == 32
      && asbd.mChannelsPerFrame > 0
      && asbd.mSampleRate > 0
  }

  /// Size the state for a format and derive the coefficients. Allocates: never call it from the
  /// render thread. Returns false (and leaves `render` a pass-through) for a format we can't
  /// process; the caller checks the sample format itself (32-bit float PCM).
  mutating func prepare(sampleRate: Double, channels: Int) -> Bool {
    release()
    guard channels > 0, channels <= 16, sampleRate > 0, sampleRate.isFinite else { return false }
    let sr = Float(sampleRate)
    let p = UnsafeMutablePointer<Float>.allocate(capacity: channels * 2)
    p.initialize(repeating: 0, count: channels * 2)
    hp = p
    self.channels = channels
    // One-pole high-pass: y[n] = a * (y[n-1] + x[n] - x[n-1]), a = RC / (RC + dt).
    let rc = 1 / (2 * Float.pi * VoiceBoostPreset.highPassHz)
    hpCoef = rc / (rc + 1 / sr)
    attackCoef = expf(-1 / (VoiceBoostPreset.attackSeconds * sr))
    releaseCoef = expf(-1 / (VoiceBoostPreset.releaseSeconds * sr))
    limReleaseCoef = expf(-1 / (VoiceBoostPreset.limiterReleaseSeconds * sr))
    mixStep = 1 / (VoiceBoostPreset.rampSeconds * sr)
    thresholdDb = VoiceBoostPreset.thresholdDb
    kneeDb = VoiceBoostPreset.kneeDb
    slope = 1 / VoiceBoostPreset.ratio - 1
    makeupDb = VoiceBoostPreset.makeupDb
    ceiling = powf(10, VoiceBoostPreset.ceilingDb / 20)
    kneeStart = powf(10, (thresholdDb - kneeDb / 2) / 20)
    mix = 0
    gainDb = 0
    gainAtDb = .infinity
    limGain = 1
    ready = true
    return true
  }

  /// Free the state. Never from the render thread.
  mutating func release() {
    hp?.deallocate()
    hp = nil
    ready = false
    channels = 0
  }

  /// Process `frames` frames in place. `enabled` is the switch: the output crossfades toward it
  /// over `rampSeconds`. Fully off and ramped down: the buffers are not touched at all. Any
  /// buffer layout that doesn't match `prepare` (too small, other channel total) passes through.
  /// Handles both interleaved buffers and one buffer per channel (what an MTAudioProcessingTap
  /// hands AVPlayer's float PCM in).
  mutating func render(_ bufferList: UnsafeMutablePointer<AudioBufferList>, frames: Int, enabled: Bool) {
    guard ready, frames > 0, let hp = hp else { return }
    let target: Float = enabled ? 1 : 0
    var mix = self.mix
    if mix == 0 && target == 0 {
      // Off and fully ramped down: untouched audio, and a clean start next time it is enabled.
      gainDb = 0
      gainAtDb = .infinity
      limGain = 1
      hp.update(repeating: 0, count: channels * 2)
      return
    }
    let abl = UnsafeMutableAudioBufferListPointer(bufferList)
    var totalChannels = 0
    for b in 0..<abl.count {
      let buf = abl[b]
      let nch = Int(buf.mNumberChannels)
      guard buf.mData != nil, nch > 0,
            Int(buf.mDataByteSize) >= frames * nch * MemoryLayout<Float>.size else { return }
      totalChannels += nch
    }
    guard totalChannels == channels else { return }

    let hpA = hpCoef
    let attack = attackCoef
    let release = releaseCoef
    let limRelease = limReleaseCoef
    let step = mixStep
    let threshold = thresholdDb
    let knee = kneeDb
    let slope = self.slope
    let makeup = makeupDb
    let ceiling = self.ceiling
    let kneeStart = self.kneeStart
    let epsilon = gainEpsilonDb
    var gainDb = self.gainDb
    var limGain = self.limGain
    var g = self.gain
    var gainAtDb = self.gainAtDb

    for f in 0..<frames {
      // Pass 1: high-pass each sample (state per channel) and find the frame's peak.
      var peak: Float = 0
      var ch = 0
      for b in 0..<abl.count {
        let buf = abl[b]
        let nch = Int(buf.mNumberChannels)
        let data = buf.mData!.assumingMemoryBound(to: Float.self)
        for c in 0..<nch {
          let x = data[f * nch + c]
          let y = hpA * (hp[ch * 2 + 1] + x - hp[ch * 2])
          hp[ch * 2] = x
          hp[ch * 2 + 1] = y
          let m = fabsf(y)
          if m > peak { peak = m }
          ch += 1
        }
      }
      // Soft-knee gain computer (Giannoulis, Massberg and Reiss 2012), in dB. Below the knee
      // (most samples: pauses, quiet speech) it wants 0 dB, with no log needed.
      var want: Float = 0
      if peak > kneeStart {
        let over = 20 * log10f(peak) - threshold
        if 2 * over > knee {
          want = slope * over
        } else if 2 * abs(over) <= knee {
          let k = over + knee / 2
          want = slope * k * k / (2 * knee)
        }
      }
      // Attack when the gain must drop, release when it may rise.
      gainDb = want < gainDb ? attack * gainDb + (1 - attack) * want : release * gainDb + (1 - release) * want
      if abs(gainDb - gainAtDb) > epsilon {
        g = powf(10, (gainDb + makeup) / 20)
        gainAtDb = gainDb
      }
      // Peak limiter: instant attack (never above the ceiling), 50 ms release.
      let out = peak * g
      if out * limGain > ceiling {
        limGain = ceiling / out
      } else {
        limGain = limRelease * limGain + (1 - limRelease)
        if out * limGain > ceiling { limGain = ceiling / out }
      }
      let wet = g * limGain
      if mix < target { mix = min(target, mix + step) } else if mix > target { mix = max(target, mix - step) }
      // Pass 2: write dry * (1 - mix) + processed * mix, the processed part held at the ceiling.
      ch = 0
      for b in 0..<abl.count {
        let buf = abl[b]
        let nch = Int(buf.mNumberChannels)
        let data = buf.mData!.assumingMemoryBound(to: Float.self)
        for c in 0..<nch {
          let i = f * nch + c
          let dry = data[i]
          var processed = hp[ch * 2 + 1] * wet
          if processed > ceiling { processed = ceiling } else if processed < -ceiling { processed = -ceiling }
          data[i] = dry + (processed - dry) * mix
          ch += 1
        }
      }
    }
    self.mix = mix
    self.gainDb = gainDb
    self.limGain = limGain
    self.gain = g
    self.gainAtDb = gainAtDb
  }
}
