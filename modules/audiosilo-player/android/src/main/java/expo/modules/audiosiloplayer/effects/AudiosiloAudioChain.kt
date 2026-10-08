package expo.modules.audiosiloplayer.effects

import androidx.media3.common.PlaybackParameters
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessorChain
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi

/**
 * The sink's processor chain: [NarrationSilenceProcessor] -> Sonic -> [VoiceBoostProcessor].
 *
 * It mirrors Media3 1.5.1's `DefaultAudioSink.DefaultAudioProcessorChain` contract, which only
 * accepts Media3's own (final, buggy in 1.5.1) silence processor; Pocket Casts'
 * `ShiftyAudioProcessorChain` replaces it the same way. Order matters:
 *  - silence skipping runs FIRST, on the book's own frames, so its skipped-frame count is book
 *    time (what [getSkippedOutputFrameCount] reports to the sink's position maths, and what
 *    "time saved" counts);
 *  - Sonic does the speed (`PlaybackParameters(speed, 1f)`; the sink keeps AudioTrack playback
 *    params off, so Sonic always does it);
 *  - Voice Boost runs LAST, on what the listener actually hears, so its attack/release times are
 *    real time at any speed.
 *
 * One instance per sink (the builder's rule: a chain must not be shared between sinks).
 */
@androidx.annotation.OptIn(UnstableApi::class)
class AudiosiloAudioChain(
  val silence: NarrationSilenceProcessor = NarrationSilenceProcessor(),
  val sonic: SonicAudioProcessor = SonicAudioProcessor(),
  val boost: VoiceBoostProcessor = VoiceBoostProcessor(),
) : AudioProcessorChain {

  private val processors: Array<AudioProcessor> = arrayOf(silence, sonic, boost)

  override fun getAudioProcessors(): Array<AudioProcessor> = processors

  override fun applyPlaybackParameters(playbackParameters: PlaybackParameters): PlaybackParameters {
    sonic.setSpeed(playbackParameters.speed)
    sonic.setPitch(playbackParameters.pitch)
    return playbackParameters
  }

  /** Called by the sink (playback thread) once it has drained; the next flush applies it. */
  override fun applySkipSilenceEnabled(skipSilenceEnabled: Boolean): Boolean {
    silence.setEnabled(skipSilenceEnabled)
    return skipSilenceEnabled
  }

  override fun getMediaDuration(playoutDuration: Long): Long =
    if (sonic.isActive) sonic.getMediaDuration(playoutDuration) else playoutDuration

  /** Frames skipped since the sink's last flush; the sink adds them to its position. */
  override fun getSkippedOutputFrameCount(): Long = silence.getSkippedFrames()
}
