import AVFoundation
import MediaToolbox

// Voice boost on iOS: an MTAudioProcessingTap per AVPlayerItem running VoiceBoostDSP.swift (an
// 80 Hz high-pass, a soft-knee compressor, make-up gain, a peak limiter), the same numbers as
// Android's VoiceBoostProcessor so the two platforms sound alike.
//
// Why our own per-sample DSP and not Apple's AUDynamicsProcessor + AUPeakLimiter rendered
// inside the tap: those units need an AudioUnit graph with a render callback that pulls from
// the tap's buffers, their parameters (no knee on AUDynamicsProcessor, no ratio on
// AUPeakLimiter) don't express the preset, and a unit's first render can allocate. Plain
// arithmetic on the buffers the tap already holds is allocation-free, lock-free, measurable on
// the Mac (SelfCheck/run.sh runs it on speech) and identical on every iOS version.
//
// Every item gets its tap when it's queued, switch on or off (AudioEngine.attachVoiceBoostTaps):
// setting `audioMix` on a PLAYING item rebuilds its render chain, an audible ~1 s dropout on a
// device. So the switch never touches the mix: it flips one word the tap reads, and the DSP
// crossfades toward it over 20 ms. Off and ramped down, the tap leaves the audio untouched.
//
// Real-time rules (the tap's `process` runs on the audio render thread): no allocation, no
// locks, no Swift retain/release of our own objects. All state lives in a plain struct
// allocated in the tap's `init` callback and freed in `finalize`; the on/off switch is one
// aligned 32-bit word allocated once for the process and read once per render call. An aligned
// 32-bit load/store is single-copy atomic on arm64 (and x86_64 for the Simulator), and nothing
// else is published through it, so it needs no ordering: the worst case is that the render
// thread sees a toggle one buffer (~10 ms) late, inside the ramp anyway. (The CF `tap` handle the
// callbacks receive is passed through at +0; an unoptimised Debug build may emit an atomic
// retain/release on it, never a lock or an allocation.)
//
// The tap's output is what AVPlayer plays: `process` pulls the source into `bufferListInOut`
// (MTAudioProcessingTapGetSourceAudio) and the DSP rewrites those same buffers in place, which
// is the tap contract (MTAudioProcessingTap.h). PreEffects only orders the tap before the audio
// mix's own volume ramps (we set none). AVPlayer hands a tap 32-bit float PCM, one buffer per
// channel, for every decoded source. Checked on the Mac when the preset was raised: a muted
// AVPlayer with this attach path, local and HTTP, AAC m4b and MP3, got flags 0x29 (float,
// packed, non-interleaved) and the mix landed while the item was still loading; and
// AVAssetReaderAudioMixOutput running this exact mix gave the DSP's output (+8.8 dB on a
// LibriVox narration) with the switch on and a bit-identical file with it off.
//
// Pre- or post-time-stretch: the tap sits on the item's audio mix track, which AVPlayer runs in
// the item's own timeline; the rate's time-pitch stage is applied after the mix, so the tap
// hears SOURCE-time audio and the 10 ms / 200 ms times are in book time (at 2x the release is
// 100 ms of wall time).

/// The state of one tap. A plain struct (no references) so the render thread never touches
/// Swift reference counting.
struct VoiceBoostState {
  /// The process-wide on/off word (VoiceBoost.enabledWord). Never freed.
  var enabled: UnsafeMutablePointer<Int32>
  var dsp = VoiceBoostDSP()
}

enum VoiceBoost {
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

  /// An audio mix that runs a new tap on `track`.
  static func makeMix(for track: AVAssetTrack) -> AVAudioMix? {
    guard let tap = makeTap() else { return nil }
    let params = AVMutableAudioMixInputParameters(track: track)
    params.audioTapProcessor = tap
    let mix = AVMutableAudioMix()
    mix.inputParameters = [params]
    return mix
  }

  /// Give `item` its tap. Asynchronous: the track list must be loaded first (`loadTracks`, never
  /// the blocking `tracks` getter on the main thread), and playback never waits for it. An item
  /// can't become ready before its asset's tracks have loaded, so the mix lands before the item
  /// plays in practice; a failure leaves the item untapped (Voice Boost then does nothing on that
  /// file, and the audio is as before).
  static func attach(to item: AVPlayerItem) {
    item.asset.loadTracks(withMediaType: .audio) { [weak item] tracks, _ in
      DispatchQueue.main.async {
        guard let item = item, item.audioMix == nil, let track = tracks?.first,
              let mix = makeMix(for: track) else { return }
        item.audioMix = mix
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
  let state = MTAudioProcessingTapGetStorage(tap).assumingMemoryBound(to: VoiceBoostState.self)
  state.pointee.dsp.release()
  state.deinitialize(count: 1)
  state.deallocate()
}

/// Called before rendering starts (possibly more than once): size the DSP for the format.
/// Allocation is allowed here, not in `process`. A format the DSP doesn't take leaves it a
/// pass-through.
private let voiceBoostTapPrepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
  let state = MTAudioProcessingTapGetStorage(tap).assumingMemoryBound(to: VoiceBoostState.self)
  let asbd = format.pointee
  guard VoiceBoostDSP.accepts(asbd) else {
    state.pointee.dsp.release()
    return
  }
  _ = state.pointee.dsp.prepare(sampleRate: asbd.mSampleRate, channels: Int(asbd.mChannelsPerFrame))
}

private let voiceBoostTapUnprepare: MTAudioProcessingTapUnprepareCallback = { tap in
  let state = MTAudioProcessingTapGetStorage(tap).assumingMemoryBound(to: VoiceBoostState.self)
  state.pointee.dsp.release()
}

private let voiceBoostTapProcess: MTAudioProcessingTapProcessCallback = {
  tap, numberFrames, _, bufferList, numberFramesOut, flagsOut in
  let status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferList, flagsOut, nil, numberFramesOut)
  guard status == noErr else { return }
  let state = MTAudioProcessingTapGetStorage(tap).assumingMemoryBound(to: VoiceBoostState.self)
  state.pointee.dsp.render(bufferList, frames: Int(numberFramesOut.pointee),
                           enabled: state.pointee.enabled.pointee != 0)
}
