import AVFoundation
import MediaToolbox

// Voice Boost on iOS: an MTAudioProcessingTap per AVPlayerItem running our own small DSP
// (80 Hz high-pass, a soft-knee compressor, a peak limiter), the same numbers as Android's
// VoiceBoostProcessor so the two platforms sound alike.
//
// Why our own per-sample DSP and not Apple's AUDynamicsProcessor + AUPeakLimiter rendered
// inside the tap: those units need an AudioUnit graph with a render callback that pulls from
// the tap's buffers, their parameters (no knee on AUDynamicsProcessor, no ratio on
// AUPeakLimiter) don't express the contract's numbers, and a unit's first render can allocate.
// Thirty lines of arithmetic on the buffers the tap already holds are allocation-free,
// lock-free, testable by ear against Android, and identical on every iOS version.
//
// Real-time rules (the tap's `process` runs on the audio render thread): no allocation, no
// locks, no Swift retain/release of our own objects. All state lives in a plain struct
// allocated in the tap's `init` callback and freed in `finalize`; the on/off switch is one
// aligned 32-bit word allocated once for the process and read once per render call. An aligned
// 32-bit load/store is single-copy atomic on arm64 (and x86_64 for the Simulator), and nothing
// else is published through it, so it needs no ordering: the worst case is that the render
// thread sees a toggle one buffer (~10 ms) late, inside the 20 ms gain ramp anyway. (The CF
// `tap` handle the callbacks receive is passed through at +0; an unoptimised Debug build may
// emit an atomic retain/release on it, never a lock or an allocation.)
//
// Pre- or post-time-stretch: the tap sits on the item's audio mix track (PreEffects), which
// AVPlayer runs in the item's own timeline; the rate's time-pitch stage is applied after the
// mix, so the tap is expected to hear SOURCE-time audio. The 10 ms / 200 ms times are therefore
// in book time (at 2x the release is 100 ms of wall time). This is not verifiable without a
// device; see the report's listening checklist.

/// The DSP state of one tap. A plain struct (no references) so the render thread never touches
/// Swift reference counting.
struct VoiceBoostState {
  /// The process-wide on/off word (VoiceBoost.enabledWord). Never freed.
  var enabled: UnsafeMutablePointer<Int32>
  /// False for a format we don't process (not 32-bit float PCM): pass the audio through.
  var formatOK = false
  var sampleRate: Float = 44_100
  var channels = 0
  /// Two floats per channel for the high-pass: previous input, previous output.
  var hp: UnsafeMutablePointer<Float>?
  var hpCoef: Float = 0
  /// Dry/processed mix, ramped toward the switch over `rampSeconds` (a hard switch clicks).
  var mix: Float = 0
  var mixStep: Float = 0
  /// Compressor gain reduction (dB, <= 0), smoothed.
  var gainDb: Float = 0
  var attackCoef: Float = 0
  var releaseCoef: Float = 0
  /// Limiter gain (linear, <= 1), instant attack, smoothed release.
  var limGain: Float = 1
  var limReleaseCoef: Float = 0
  // The VoiceBoost constants, copied in `prepare`: reading a Swift static from the render thread
  // can run its lazy initialiser (swift_once, a lock) the first time.
  var thresholdDb: Float = 0
  var kneeDb: Float = 1
  var slope: Float = 0
  var makeupDb: Float = 0
  var ceiling: Float = 1
}

enum VoiceBoost {
  // The contract's numbers (decision 7), shared with Android's VoiceBoostProcessor.
  static let thresholdDb: Float = -24
  static let ratio: Float = 3
  static let kneeDb: Float = 6
  static let attackSeconds: Float = 0.010
  static let releaseSeconds: Float = 0.200
  static let makeupDb: Float = 6
  static let ceilingDb: Float = -1
  static let highPassHz: Float = 80
  static let rampSeconds: Float = 0.020
  static let limiterReleaseSeconds: Float = 0.050

  /// The switch every tap reads. Allocated once on first use (always from the main thread: the
  /// engine reads it in `setConfig` and `makeTap`), never freed: a tap may outlive the engine
  /// (AVFoundation releases items on its own schedule), so its pointer must stay valid forever.
  private static let enabledWord: UnsafeMutablePointer<Int32> = {
    let p = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
    p.initialize(to: 0)
    return p
  }()

  /// Main thread only.
  static var isEnabled: Bool {
    get { enabledWord.pointee != 0 }
    set { enabledWord.pointee = newValue ? 1 : 0 }
  }

  /// A new tap (each AVPlayerItem needs its own: a tap belongs to one audio mix).
  static func makeTap() -> MTAudioProcessingTap? {
    var callbacks = MTAudioProcessingTapCallbacks(
      version: kMTAudioProcessingTapCallbacksVersion_0,
      clientInfo: UnsafeMutableRawPointer(enabledWord),
      init: voiceBoostTapInit,
      finalize: voiceBoostTapFinalize,
      prepare: voiceBoostTapPrepare,
      unprepare: voiceBoostTapUnprepare,
      process: voiceBoostTapProcess)
    var tap: MTAudioProcessingTap?
    let status = MTAudioProcessingTapCreate(
      kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PreEffects, &tap)
    return status == noErr ? tap : nil
  }

  /// Attach a tap to `item`'s audio track. Asynchronous: the track list must be loaded first
  /// (`loadTracks`, never the blocking `tracks` getter on the main thread), and playback does not
  /// wait for it: the item plays untapped until the mix is set (it is only attached while the
  /// switch has been on, see AudioEngine.voiceBoostAttached). `done` runs on main.
  static func attach(to item: AVPlayerItem, done: @escaping (Bool) -> Void) {
    item.asset.loadTracks(withMediaType: .audio) { [weak item] tracks, _ in
      DispatchQueue.main.async {
        guard let item = item, let track = tracks?.first, let tap = makeTap() else {
          done(false)
          return
        }
        let params = AVMutableAudioMixInputParameters(track: track)
        params.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [params]
        item.audioMix = mix
        done(true)
      }
    }
  }
}

// MARK: - Tap callbacks (C function pointers: no captures)

private let voiceBoostTapInit: MTAudioProcessingTapInitCallback = { _, clientInfo, storageOut in
  guard let word = clientInfo?.assumingMemoryBound(to: Int32.self) else {
    storageOut.pointee = nil
    return
  }
  let state = UnsafeMutablePointer<VoiceBoostState>.allocate(capacity: 1)
  state.initialize(to: VoiceBoostState(enabled: word))
  storageOut.pointee = UnsafeMutableRawPointer(state)
}

private let voiceBoostTapFinalize: MTAudioProcessingTapFinalizeCallback = { tap in
  let raw = MTAudioProcessingTapGetStorage(tap)
  let state = raw.assumingMemoryBound(to: VoiceBoostState.self)
  state.pointee.hp?.deallocate()
  state.deinitialize(count: 1)
  state.deallocate()
}

/// Called before rendering starts (possibly more than once): read the format, size the
/// per-channel state, derive the coefficients. Allocation is allowed here, not in `process`.
private let voiceBoostTapPrepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
  let state = MTAudioProcessingTapGetStorage(tap).assumingMemoryBound(to: VoiceBoostState.self)
  let asbd = format.pointee
  state.pointee.hp?.deallocate()
  state.pointee.hp = nil
  let isFloat32 = asbd.mFormatID == kAudioFormatLinearPCM
    && (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    && asbd.mBitsPerChannel == 32
  let channels = Int(asbd.mChannelsPerFrame)
  guard isFloat32, channels > 0, channels <= 16, asbd.mSampleRate > 0 else {
    state.pointee.formatOK = false
    return
  }
  let sr = Float(asbd.mSampleRate)
  let hp = UnsafeMutablePointer<Float>.allocate(capacity: channels * 2)
  hp.initialize(repeating: 0, count: channels * 2)
  state.pointee.hp = hp
  state.pointee.channels = channels
  state.pointee.sampleRate = sr
  // One-pole high-pass: y[n] = a * (y[n-1] + x[n] - x[n-1]), a = RC / (RC + dt).
  let rc = 1 / (2 * Float.pi * VoiceBoost.highPassHz)
  state.pointee.hpCoef = rc / (rc + 1 / sr)
  state.pointee.attackCoef = expf(-1 / (VoiceBoost.attackSeconds * sr))
  state.pointee.releaseCoef = expf(-1 / (VoiceBoost.releaseSeconds * sr))
  state.pointee.limReleaseCoef = expf(-1 / (VoiceBoost.limiterReleaseSeconds * sr))
  state.pointee.mixStep = 1 / (VoiceBoost.rampSeconds * sr)
  state.pointee.thresholdDb = VoiceBoost.thresholdDb
  state.pointee.kneeDb = VoiceBoost.kneeDb
  state.pointee.slope = 1 / VoiceBoost.ratio - 1
  state.pointee.makeupDb = VoiceBoost.makeupDb
  state.pointee.ceiling = powf(10, VoiceBoost.ceilingDb / 20)
  state.pointee.mix = 0
  state.pointee.gainDb = 0
  state.pointee.limGain = 1
  state.pointee.formatOK = true
}

private let voiceBoostTapUnprepare: MTAudioProcessingTapUnprepareCallback = { tap in
  let state = MTAudioProcessingTapGetStorage(tap).assumingMemoryBound(to: VoiceBoostState.self)
  state.pointee.hp?.deallocate()
  state.pointee.hp = nil
  state.pointee.formatOK = false
}

private let voiceBoostTapProcess: MTAudioProcessingTapProcessCallback = {
  tap, numberFrames, _, bufferList, numberFramesOut, flagsOut in
  let status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferList, flagsOut, nil, numberFramesOut)
  guard status == noErr else { return }
  let state = MTAudioProcessingTapGetStorage(tap).assumingMemoryBound(to: VoiceBoostState.self)
  voiceBoostRender(state, bufferList, Int(numberFramesOut.pointee))
}

/// The DSP, in place. Frame-major so every channel shares one gain (a linked stereo detector:
/// per-channel gains would shift the voice's stereo image).
@inline(__always)
private func voiceBoostRender(_ s: UnsafeMutablePointer<VoiceBoostState>,
                              _ bufferList: UnsafeMutablePointer<AudioBufferList>,
                              _ frames: Int) {
  guard s.pointee.formatOK, frames > 0, let hp = s.pointee.hp else { return }
  let target: Float = s.pointee.enabled.pointee != 0 ? 1 : 0
  var mix = s.pointee.mix
  if mix == 0 && target == 0 {
    // Off and fully ramped down: untouched audio, and a clean start next time it is enabled.
    s.pointee.gainDb = 0
    s.pointee.limGain = 1
    hp.update(repeating: 0, count: s.pointee.channels * 2)
    return
  }
  let abl = UnsafeMutableAudioBufferListPointer(bufferList)
  // Validate the layout once per call: every buffer large enough for `frames`, and the
  // channel total matching what prepare saw. Anything unexpected passes through untouched.
  var totalChannels = 0
  for b in 0..<abl.count {
    let buf = abl[b]
    let nch = Int(buf.mNumberChannels)
    guard buf.mData != nil, nch > 0,
          Int(buf.mDataByteSize) >= frames * nch * MemoryLayout<Float>.size else { return }
    totalChannels += nch
  }
  guard totalChannels == s.pointee.channels else { return }

  let hpA = s.pointee.hpCoef
  let attack = s.pointee.attackCoef
  let release = s.pointee.releaseCoef
  let limRelease = s.pointee.limReleaseCoef
  let step = s.pointee.mixStep
  let threshold = s.pointee.thresholdDb
  let knee = s.pointee.kneeDb
  let slope = s.pointee.slope
  let makeup = s.pointee.makeupDb
  let ceiling = s.pointee.ceiling
  var gainDb = s.pointee.gainDb
  var limGain = s.pointee.limGain

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
    // Soft-knee gain computer (Giannoulis, Massberg and Reiss 2012), in dB.
    let level = 20 * log10f(max(peak, 1e-9))
    let over = level - threshold
    var want: Float = 0
    if 2 * over > knee {
      want = slope * over
    } else if 2 * abs(over) <= knee {
      let k = over + knee / 2
      want = slope * k * k / (2 * knee)
    }
    // Attack when the gain must drop, release when it may rise.
    gainDb = want < gainDb ? attack * gainDb + (1 - attack) * want : release * gainDb + (1 - release) * want
    let g = powf(10, (gainDb + makeup) / 20)
    // Peak limiter: instant attack (never above the ceiling), 50 ms release.
    let out = peak * g
    if out * limGain > ceiling {
      limGain = ceiling / out
    } else {
      limGain = limRelease * limGain + (1 - limRelease)
      if out * limGain > ceiling { limGain = ceiling / out }
    }
    let wet = g * limGain
    // Ramp the dry/processed mix toward the switch.
    if mix < target { mix = min(target, mix + step) } else if mix > target { mix = max(target, mix - step) }
    // Pass 2: write dry * (1 - mix) + processed * mix, clamped to the ceiling while processed.
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
  s.pointee.mix = mix
  s.pointee.gainDb = gainDb
  s.pointee.limGain = limGain
}
