package expo.modules.audiosiloplayer.effects

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin

/** Synthetic interleaved 16-bit PCM for the effects tests, and a sink-like driver. */
internal class PcmBuilder(val sampleRate: Int, val channels: Int) {
  private var data = ShortArray(sampleRate * channels)
  private var frames = 0

  fun frames(ms: Double): Int = (ms * sampleRate / 1000.0).roundToInt()

  private fun ensure(extraFrames: Int) {
    val need = (frames + extraFrames) * channels
    if (need > data.size) data = data.copyOf(maxOf(need, data.size * 2))
  }

  /** A sine at [amplitude] (peak, in sample units) for [ms]; right channel at 80% (not mono). */
  fun tone(ms: Double, hz: Double, amplitude: Double): PcmBuilder {
    val n = frames(ms)
    ensure(n)
    for (i in 0 until n) {
      val v = amplitude * sin(2.0 * PI * hz * (frames + i) / sampleRate)
      for (ch in 0 until channels) {
        val scale = if (ch == 0) 1.0 else 0.8
        data[(frames + i) * channels + ch] = (v * scale).roundToInt().coerceIn(-32768, 32767).toShort()
      }
    }
    frames += n
    return this
  }

  /** A "spoken word": a 300 Hz voiced part, then a quiet sibilant tail at [tailAmplitude]. */
  fun word(voicedMs: Double = 300.0, tailMs: Double = 80.0, tailAmplitude: Double = TAIL_38_DBFS): PcmBuilder =
    tone(voicedMs, 300.0, 6000.0).tone(tailMs, 2500.0, tailAmplitude)

  /** A room-tone floor below the silence threshold (deterministic pseudo-random, |x| <= peak). */
  fun floor(ms: Double, peak: Int = 200): PcmBuilder {
    val n = frames(ms)
    ensure(n)
    var seed = 0x2545F491L + frames
    for (i in 0 until n * channels) {
      seed = (seed * 6364136223846793005L + 1442695040888963407L)
      val r = ((seed ushr 33) % (2 * peak + 1)).toInt() - peak
      data[frames * channels + i] = r.toShort()
    }
    frames += n
    return this
  }

  fun build(): ShortArray = data.copyOf(frames * channels)

  companion object {
    /** -38 dBFS peak: 32768 x 10^(-38/20) ~ 412, above the 330 threshold. */
    const val TAIL_38_DBFS = 413.0
  }
}

/**
 * Feeds [input] through [processor] in [chunkFrames]-frame buffers the way the sink's pipeline
 * does (queue until consumed, collecting output after each call), then drains at end of stream.
 * [beforeChunk] runs before each buffer with the index of its first frame (to flip switches).
 */
internal fun runProcessor(
  processor: AudioProcessor,
  input: ShortArray,
  channels: Int,
  chunkFrames: Int,
  beforeChunk: (firstFrame: Int) -> Unit = {},
): ShortArray {
  val out = ArrayList<Short>(input.size)
  fun collect() {
    val o = processor.output
    while (o.hasRemaining()) out.add(o.short)
  }
  val buffer = ByteBuffer.allocateDirect(chunkFrames * channels * 2).order(ByteOrder.nativeOrder())
  var i = 0
  while (i < input.size) {
    beforeChunk(i / channels)
    buffer.clear()
    val n = minOf(chunkFrames * channels, input.size - i)
    for (k in 0 until n) buffer.putShort(input[i + k])
    buffer.flip()
    var guard = 0
    while (buffer.hasRemaining()) {
      processor.queueInput(buffer)
      collect()
      check(++guard < 100_000) { "processor stopped consuming input" }
    }
    collect()
    i += n
  }
  processor.queueEndOfStream()
  var guard = 0
  while (!processor.isEnded) {
    collect()
    check(++guard < 100_000) { "processor never ended" }
  }
  return out.toShortArray()
}

internal fun pcm16(sampleRate: Int, channels: Int) =
  AudioProcessor.AudioFormat(sampleRate, channels, C.ENCODING_PCM_16BIT)
