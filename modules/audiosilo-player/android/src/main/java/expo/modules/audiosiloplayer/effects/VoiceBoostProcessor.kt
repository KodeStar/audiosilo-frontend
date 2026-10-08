package expo.modules.audiosiloplayer.effects

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Voice Boost (Phase 6 contract, decision 7): makes quiet narration easier to follow in noise.
 * Placed AFTER Sonic in [AudiosiloAudioChain], so it sees the sped-up signal and its timings are
 * real time. 16-bit PCM in and out (the sink's float output is off, so the chain is always
 * 16-bit). Every channel shares one gain (stereo-linked), so the image never shifts.
 *
 * The wet path: an optional 80 Hz high-pass (rumble, handling noise), a compressor (-24 dBFS,
 * 3:1, 6 dB soft knee, 10 ms attack, 200 ms release, +6 dB make-up), a peak limiter (ceiling
 * -1 dBFS, ~1 ms attack, 80 ms release) and a final clip at the ceiling, which only the first
 * millisecond of a sudden loud onset can reach (the limiter has no look-ahead, so it adds no
 * latency and holds no audio across a drain or a flush).
 *
 * ALWAYS active: [isActive] never changes with the switch, because a change would make the sink
 * flush (a gap and a position jump on every toggle). The switch ([enabled], read once per buffer)
 * instead moves a ~20 ms linear ramp between the dry input and the wet signal. Fully off, the
 * output is the input byte for byte (a bulk copy, no DSP), so a listener with Voice Boost off
 * hears exactly what they heard before it existed.
 *
 * Real-time rules: [queueInput] runs on the playback thread and never allocates (beyond the base
 * class's reusable output buffer) or locks; per-channel state is sized in [onFlush].
 */
@androidx.annotation.OptIn(UnstableApi::class)
class VoiceBoostProcessor(
  /** The listener's switch, shared with [AudioEffects] so it survives a new player/chain. */
  private val switch: AtomicBoolean = AtomicBoolean(false),
  /** Apply the 80 Hz high-pass on the wet path. */
  private val highPass: Boolean = true,
) : BaseAudioProcessor() {

  /** Whether the boost is (or is ramping to) on. Safe from any thread. */
  var enabled: Boolean
    get() = switch.get()
    set(value) = switch.set(value)

  private var channelCount = 0
  private var sampleRate = 0

  // High-pass biquad (RBJ cookbook, Butterworth Q), transposed direct form II, per channel.
  private var hpB0 = 1.0
  private var hpB1 = 0.0
  private var hpB2 = 0.0
  private var hpA1 = 0.0
  private var hpA2 = 0.0
  private var hpZ1 = DoubleArray(0)
  private var hpZ2 = DoubleArray(0)
  private var frame = DoubleArray(0)

  // Compressor: smoothed gain change in dB (<= 0).
  private var compAttack = 0.0
  private var compRelease = 0.0
  private var compGainDb = 0.0

  // Limiter: peak envelope (linear).
  private var limAttack = 0.0
  private var limRelease = 0.0
  private var limEnvelope = 0.0

  // Dry/wet ramp: the current wet fraction and its per-frame step.
  private var mix = 0.0
  private var mixStep = 1.0

  /** True while the wet path is fully off and skipped; its state is reset before it resumes. */
  private var dspIdle = true

  override fun onConfigure(
    inputFormat: AudioProcessor.AudioFormat,
  ): AudioProcessor.AudioFormat {
    if (inputFormat.encoding != C.ENCODING_PCM_16BIT) {
      throw AudioProcessor.UnhandledAudioFormatException(inputFormat)
    }
    if (inputFormat.sampleRate == Format.NO_VALUE) {
      return AudioProcessor.AudioFormat.NOT_SET
    }
    return inputFormat
  }

  override fun onFlush() {
    val format = inputAudioFormat
    if (format.channelCount != channelCount || format.sampleRate != sampleRate) {
      // A new format (not the audio thread's steady state): size the per-channel state.
      channelCount = format.channelCount
      sampleRate = format.sampleRate
      if (channelCount > 0 && sampleRate > 0) configureDsp()
    }
    // Keep the dynamics and the ramp across a flush: the sink also flushes after a drain that
    // continues the same audio (a Smart Speed toggle), and a reset there would pump the level.
    // A seek's new audio simply re-converges within the attack time.
  }

  override fun onReset() {
    channelCount = 0
    sampleRate = 0
    dspIdle = true
    mix = 0.0
  }

  private fun configureDsp() {
    val fs = sampleRate.toDouble()
    // RBJ high-pass, f0 = 80 Hz, Q = 1/sqrt(2).
    val w0 = 2.0 * PI * HIGH_PASS_HZ / fs
    val cosW = cos(w0)
    val alpha = sin(w0) / (2.0 * (1.0 / sqrt(2.0)))
    val a0 = 1.0 + alpha
    hpB0 = (1.0 + cosW) / 2.0 / a0
    hpB1 = -(1.0 + cosW) / a0
    hpB2 = (1.0 + cosW) / 2.0 / a0
    hpA1 = -2.0 * cosW / a0
    hpA2 = (1.0 - alpha) / a0
    hpZ1 = DoubleArray(channelCount)
    hpZ2 = DoubleArray(channelCount)
    frame = DoubleArray(channelCount)

    compAttack = timeCoefficient(COMP_ATTACK_S, fs)
    compRelease = timeCoefficient(COMP_RELEASE_S, fs)
    limAttack = timeCoefficient(LIMIT_ATTACK_S, fs)
    limRelease = timeCoefficient(LIMIT_RELEASE_S, fs)
    mixStep = 1.0 / max(1.0, RAMP_S * fs)
    resetDynamics()
  }

  private fun resetDynamics() {
    hpZ1.fill(0.0)
    hpZ2.fill(0.0)
    compGainDb = 0.0
    limEnvelope = 0.0
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val start = inputBuffer.position()
    val end = inputBuffer.limit()
    val size = end - start
    if (size == 0) return

    val on = switch.get()
    if (!on && mix <= 0.0) {
      // Fully off: pass the input through untouched.
      dspIdle = true
      replaceOutputBuffer(size).put(inputBuffer).flip()
      return
    }
    if (dspIdle) {
      // Resuming from idle: the old dynamics state belongs to audio heard long ago.
      resetDynamics()
      dspIdle = false
    }

    val channels = channelCount
    val bytesPerFrame = channels * 2
    val frames = size / bytesPerFrame
    val output = replaceOutputBuffer(frames * bytesPerFrame)
    val target = if (on) 1.0 else 0.0
    var p = start
    for (f in 0 until frames) {
      // Ramp first, so the first frame after a toggle already moves.
      if (mix < target) {
        mix = min(1.0, mix + mixStep)
      } else if (mix > target) {
        mix = max(0.0, mix - mixStep)
      }

      // High-pass (or not) and find the frame's peak for the linked detector.
      var peak = 0.0
      for (ch in 0 until channels) {
        val x = inputBuffer.getShort(p + ch * 2) / FULL_SCALE
        val y =
          if (highPass) {
            val out = hpB0 * x + hpZ1[ch]
            hpZ1[ch] = hpB1 * x - hpA1 * out + hpZ2[ch]
            hpZ2[ch] = hpB2 * x - hpA2 * out
            out
          } else {
            x
          }
        frame[ch] = y
        val a = abs(y)
        if (a > peak) peak = a
      }

      // Compressor: static curve with a soft knee, then attack/release smoothing in dB.
      val levelDb = DB_PER_LN * ln(max(peak, MIN_LEVEL))
      val targetGainDb = compressorGainDb(levelDb)
      compGainDb =
        if (targetGainDb < compGainDb) {
          compAttack * compGainDb + (1.0 - compAttack) * targetGainDb
        } else {
          compRelease * compGainDb + (1.0 - compRelease) * targetGainDb
        }
      val compGain = exp((compGainDb + MAKEUP_DB) / DB_PER_LN)

      // Limiter: peak envelope of the compressed frame; gain pulls it to the ceiling.
      val compressedPeak = peak * compGain
      limEnvelope =
        if (compressedPeak > limEnvelope) {
          limAttack * limEnvelope + (1.0 - limAttack) * compressedPeak
        } else {
          limRelease * limEnvelope + (1.0 - limRelease) * compressedPeak
        }
      val limGain = if (limEnvelope > CEILING) CEILING / limEnvelope else 1.0
      val wetGain = compGain * limGain

      for (ch in 0 until channels) {
        val dry = inputBuffer.getShort(p + ch * 2)
        if (mix <= 0.0) {
          output.putShort(dry)
          continue
        }
        // The final clip: only a sudden onset's first ~1 ms (inside the limiter's attack) gets here.
        val wet = (frame[ch] * wetGain).coerceIn(-CEILING, CEILING) * FULL_SCALE
        val mixed = if (mix >= 1.0) wet else dry + mix * (wet - dry)
        output.putShort(mixed.roundToInt().coerceIn(SHORT_MIN, SHORT_MAX).toShort())
      }
      p += bytesPerFrame
    }
    inputBuffer.position(start + frames * bytesPerFrame)
    output.flip()
  }

  companion object {
    private const val FULL_SCALE = 32768.0
    private const val SHORT_MIN = Short.MIN_VALUE.toInt()
    private const val SHORT_MAX = Short.MAX_VALUE.toInt()
    private const val MIN_LEVEL = 1e-6 // -120 dBFS: keeps ln() finite on digital silence
    private val DB_PER_LN = 20.0 / ln(10.0)

    const val HIGH_PASS_HZ = 80.0
    const val THRESHOLD_DB = -24.0
    const val RATIO = 3.0
    const val KNEE_DB = 6.0
    const val COMP_ATTACK_S = 0.010
    const val COMP_RELEASE_S = 0.200
    const val MAKEUP_DB = 6.0
    const val CEILING_DB = -1.0
    const val LIMIT_ATTACK_S = 0.001
    const val LIMIT_RELEASE_S = 0.080
    const val RAMP_S = 0.020

    /** The limiter ceiling as a linear amplitude (-1 dBFS ~ 0.891). */
    val CEILING = exp(CEILING_DB / (20.0 / ln(10.0)))

    /** One-pole smoothing coefficient reaching ~63% in [seconds]. */
    private fun timeCoefficient(seconds: Double, sampleRate: Double): Double =
      exp(-1.0 / (seconds * sampleRate))

    /**
     * The compressor's static gain change (dB, <= 0) for an input level, with a quadratic soft
     * knee of [KNEE_DB] centred on [THRESHOLD_DB] (Giannoulis, Massberg and Reiss, JAES 2012).
     */
    fun compressorGainDb(levelDb: Double): Double {
      val over = levelDb - THRESHOLD_DB
      return when {
        2.0 * over < -KNEE_DB -> 0.0
        2.0 * abs(over) <= KNEE_DB -> {
          val k = over + KNEE_DB / 2.0
          (1.0 / RATIO - 1.0) * k * k / (2.0 * KNEE_DB)
        }
        else -> (1.0 / RATIO - 1.0) * over
      }
    }
  }
}
