/*
 * Copyright (C) 2018 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Provenance: a Kotlin port of androidx.media3.exoplayer.audio.SilenceSkippingAudioProcessor
 * from androidx/media tag 1.11.1
 * (https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/SilenceSkippingAudioProcessor.java),
 * Apache License 2.0. The algorithm, its states and its arithmetic are unchanged.
 *
 * Why vendored: the app pins Media3 1.5.1, whose copy of this class sizes its "maybe silence"
 * buffer in FRAMES but uses it as BYTES (androidx/media#3271), so in stereo it keeps a quarter
 * of the intended padding around every word, and it computes its fades per byte instead of per
 * frame. 1.11.1 carries both fixes. DefaultAudioProcessorChain only accepts Media3's own final
 * class, so AudiosiloAudioChain installs this one instead (as Pocket Casts does).
 *
 * Changes from the 1.11.1 source:
 *  - Java -> Kotlin; Guava's checkArgument/checkState -> Kotlin require/check (their messages are
 *    lazy lambdas, so nothing allocates on the audio thread unless a check fails).
 *  - onFlush(StreamMetadata) -> onFlush(): 1.5.1's BaseAudioProcessor has no StreamMetadata.
 *  - Util.EMPTY_BYTE_ARRAY -> a local empty array (keeps Util's static init out of JVM tests).
 *  - Narration defaults (see the companion) instead of Media3's podcast-ish ones.
 *  - A monotonic count of the book time the skipped frames were worth ([savedUs], optionally
 *    shared process-wide), incremented wherever [skippedFrames] grows. [skippedFrames] itself
 *    still resets on every flush: DefaultAudioSink's position maths (applySkipping) adds it to the
 *    playout position since the last flush, so it must not be made monotonic.
 *  - The deprecated (minimumSilenceDurationUs, paddingSilenceUs, threshold) constructor is gone.
 */
package expo.modules.audiosiloplayer.effects

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.min

/**
 * An [AudioProcessor] that skips silence in the input stream. Input and output are 16-bit PCM.
 *
 * With the narration defaults: a pause shorter than 300 ms passes untouched; a longer one keeps
 * 150 ms at each side of the words around it (faded, never cut), plus a quarter of the rest, and
 * never more than 1 s in total. The trimmed part plays at 10% volume rather than true silence, so
 * playback never sounds stopped.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class NarrationSilenceProcessor(
  /** Duration of audio that must be below [silenceThresholdLevel] before silence is trimmed. */
  private val minimumSilenceDurationUs: Long = DEFAULT_MINIMUM_SILENCE_DURATION_US,
  /** Fraction of the original silence to keep, in [0, 1]. */
  private val silenceRetentionRatio: Float = DEFAULT_SILENCE_RETENTION_RATIO,
  /** Maximum silence to keep, applied after [silenceRetentionRatio]. */
  private val maxSilenceToKeepDurationUs: Long = DEFAULT_MAX_SILENCE_TO_KEEP_DURATION_US,
  /** Volume percentage kept while muting (true zero sounds like playback stopped). */
  private val minVolumeToKeepPercentageWhenMuting: Int = DEFAULT_MIN_VOLUME_TO_KEEP_PERCENTAGE,
  /** Absolute level below which an individual PCM sample is classified as silent. */
  private val silenceThresholdLevel: Short = DEFAULT_SILENCE_THRESHOLD_LEVEL,
  /**
   * Book microseconds removed, added to on every skip. Pass a process-wide counter to sum several
   * processor instances (a new player builds a new chain); it is only ever increased.
   */
  val savedUs: AtomicLong = AtomicLong(),
) : BaseAudioProcessor() {

  init {
    require(silenceRetentionRatio in 0f..1f) { "silenceRetentionRatio must be in [0, 1]" }
  }

  private var bytesPerFrame = 0

  @Volatile private var enabled = false
  private var state = STATE_NOISY

  /** Frames skipped since the last flush (the sink's position maths reads this). */
  @Volatile private var skippedFrames = 0L

  /** The frames of silence output since the last noise. Enforces [maxSilenceToKeepDurationUs]. */
  private var outputSilenceFramesSinceNoise = 0

  /**
   * Buffers audio that may be silence while in [STATE_SHORTENING_SILENCE]. If the input becomes
   * noisy before the buffer has filled, it is output without shortening. Otherwise it is output
   * when filled, as shortened silence, and emptied.
   */
  private var maybeSilenceBuffer: ByteArray = EMPTY_BYTE_ARRAY

  /** Index into [maybeSilenceBuffer] where silence that has not been output starts. */
  private var maybeSilenceBufferStartIndex = 0

  /**
   * Bytes of content in [maybeSilenceBuffer], counted from [maybeSilenceBufferStartIndex] and
   * possibly wrapping around to the start. Never greater than the buffer's length.
   */
  private var maybeSilenceBufferContentsSize = 0

  /** Holds a contiguous copy of part of [maybeSilenceBuffer] for output. */
  private var contiguousOutputBuffer: ByteArray = EMPTY_BYTE_ARRAY

  /**
   * Sets whether to shorten silence in the input. May only be called after draining data through
   * the processor. [isActive] may change, and the processor must be flushed before queueing more.
   */
  fun setEnabled(enabled: Boolean) {
    this.enabled = enabled
  }

  /** Input frames skipped as silence since the last flush (resets on flush, like Media3's). */
  fun getSkippedFrames(): Long = skippedFrames

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

  override fun isActive(): Boolean = super.isActive() && enabled

  override fun queueInput(inputBuffer: ByteBuffer) {
    while (inputBuffer.hasRemaining() && !hasPendingOutput()) {
      when (state) {
        STATE_NOISY -> processNoisy(inputBuffer)
        STATE_SHORTENING_SILENCE -> shortenSilenceSilenceUntilNoise(inputBuffer)
        else -> throw IllegalStateException()
      }
    }
  }

  override fun onQueueEndOfStream() {
    // The maybeSilenceBuffer is only written to in STATE_SHORTENING_SILENCE, and is always
    // completely flushed before leaving that state.
    if (maybeSilenceBufferContentsSize > 0) {
      // The final chunk of shortened silence is output to simulate a transition back to the
      // noisy state and the end of output.
      outputShortenedSilenceBuffer(shouldTransitionToNoisyState = true)
      outputSilenceFramesSinceNoise = 0
    }
  }

  override fun onFlush() {
    if (isActive()) {
      bytesPerFrame = inputAudioFormat.channelCount * 2
      // androidx/media#3271: the buffer is sized in BYTES (frames x bytesPerFrame). Divided by
      // 2 so it splits into two bytesPerFrame-aligned halves.
      val maybeSilenceBufferSize =
        alignToBytePerFrameBoundary(
          durationUsToFrames(minimumSilenceDurationUs) * bytesPerFrame / 2,
        ) * 2
      if (maybeSilenceBuffer.size != maybeSilenceBufferSize) {
        maybeSilenceBuffer = ByteArray(maybeSilenceBufferSize)
        contiguousOutputBuffer = ByteArray(maybeSilenceBufferSize)
      }
    }
    state = STATE_NOISY
    skippedFrames = 0
    outputSilenceFramesSinceNoise = 0
    maybeSilenceBufferStartIndex = 0
    maybeSilenceBufferContentsSize = 0
  }

  override fun onReset() {
    enabled = false
    maybeSilenceBuffer = EMPTY_BYTE_ARRAY
    contiguousOutputBuffer = EMPTY_BYTE_ARRAY
  }

  /** Processes new input while in [STATE_NOISY], updating the state if needed. */
  private fun processNoisy(inputBuffer: ByteBuffer) {
    val limit = inputBuffer.limit()

    // Check if there's any noise within the maybe silence buffer duration.
    inputBuffer.limit(min(limit, inputBuffer.position() + maybeSilenceBuffer.size))
    val noiseLimit = findNoiseLimit(inputBuffer)
    if (noiseLimit == inputBuffer.position()) {
      // The buffer contains the start of possible silence.
      state = STATE_SHORTENING_SILENCE
    } else {
      inputBuffer.limit(min(noiseLimit, inputBuffer.capacity()))
      output(inputBuffer)
    }

    // Restore the limit.
    inputBuffer.limit(limit)
  }

  /**
   * Processes new input while in [STATE_SHORTENING_SILENCE], updating the state if needed.
   *
   * Silence shorter than [minimumSilenceDurationUs] is output unchanged. Longer silence is output
   * as: half a buffer faded out (no discontinuity); 0 to ([maxSilenceToKeepDurationUs] - padding)
   * of muted, shortened silence (its discontinuities are inaudible because it is muted); and a
   * final half buffer faded in, which leads into the next noise with no discontinuity.
   *
   * Writes to [maybeSilenceBuffer] in contiguous blocks; if the silence wraps around the end of the
   * buffer, the start is filled on the next call.
   */
  private fun shortenSilenceSilenceUntilNoise(inputBuffer: ByteBuffer) {
    check(maybeSilenceBufferStartIndex < maybeSilenceBuffer.size)

    val limit = inputBuffer.limit()
    val noisePosition = findNoisePosition(inputBuffer)
    val silenceInputSize = noisePosition - inputBuffer.position()

    val indexToWriteTo: Int
    val contiguousBufferRemaining: Int
    if (maybeSilenceBufferStartIndex + maybeSilenceBufferContentsSize < maybeSilenceBuffer.size) {
      // ^0---^start---^end---^length
      contiguousBufferRemaining =
        maybeSilenceBuffer.size - (maybeSilenceBufferContentsSize + maybeSilenceBufferStartIndex)
      indexToWriteTo = maybeSilenceBufferStartIndex + maybeSilenceBufferContentsSize
    } else {
      // The bytes have wrapped around.  ^0---^end---^start---^length
      val amountInUpperPartOfBuffer = maybeSilenceBuffer.size - maybeSilenceBufferStartIndex
      indexToWriteTo = maybeSilenceBufferContentsSize - amountInUpperPartOfBuffer
      contiguousBufferRemaining = maybeSilenceBufferStartIndex - indexToWriteTo
    }

    val noiseFound = noisePosition < limit
    // Fill as much of the silence buffer as possible.
    val bytesOfInput = min(silenceInputSize, contiguousBufferRemaining)
    inputBuffer.limit(inputBuffer.position() + bytesOfInput)
    inputBuffer.get(maybeSilenceBuffer, indexToWriteTo, bytesOfInput)
    maybeSilenceBufferContentsSize += bytesOfInput

    check(maybeSilenceBufferContentsSize <= maybeSilenceBuffer.size)

    // The silence before the noise is not enough to fill the remaining buffer.
    val shouldTransitionToNoisyState = noiseFound && silenceInputSize < contiguousBufferRemaining

    outputShortenedSilenceBuffer(shouldTransitionToNoisyState)

    if (shouldTransitionToNoisyState) {
      state = STATE_NOISY
      outputSilenceFramesSinceNoise = 0
    }

    // Restore the limit.
    inputBuffer.limit(limit)
  }

  /** See [shortenSilenceSilenceUntilNoise]. */
  private fun outputShortenedSilenceBuffer(shouldTransitionToNoisyState: Boolean) {
    val sizeBeforeOutput = maybeSilenceBufferContentsSize
    val bytesToOutput: Int
    val bytesConsumed: Int
    // Only output when the buffer is full or when transitioning to the noisy state.
    if (maybeSilenceBufferContentsSize == maybeSilenceBuffer.size || shouldTransitionToNoisyState) {
      if (outputSilenceFramesSinceNoise == 0) {
        // The beginning of a silence chunk: keep MINIMUM_SILENCE_DURATION_US / 2 of it.
        if (shouldTransitionToNoisyState) {
          bytesToOutput = maybeSilenceBufferContentsSize
          outputSilence(bytesToOutput, DO_NOT_CHANGE_VOLUME)
          bytesConsumed = bytesToOutput
        } else {
          check(maybeSilenceBufferContentsSize >= maybeSilenceBuffer.size / 2)
          // Always output exactly buffer size / 2, so no shortening is needed here.
          bytesToOutput = maybeSilenceBuffer.size / 2
          outputSilence(bytesToOutput, FADE_OUT)
          bytesConsumed = bytesToOutput
        }
      } else if (shouldTransitionToNoisyState) {
        val bytesRemainingAfterOutputtingHalfMin =
          maybeSilenceBufferContentsSize - maybeSilenceBuffer.size / 2

        bytesConsumed = bytesRemainingAfterOutputtingHalfMin + maybeSilenceBuffer.size / 2
        val shortenedSilenceLength =
          calculateShortenedSilenceLength(bytesRemainingAfterOutputtingHalfMin)

        // For simplicity, fade in over the shortened silence and the half buffer of padding.
        // This slightly increases the padding, which only helps the sound quality.
        bytesToOutput = maybeSilenceBuffer.size / 2 + shortenedSilenceLength
        outputSilence(bytesToOutput, FADE_IN)
      } else {
        // Output as much as possible while keeping half the buffer full, so half the minimum
        // silence can be output later as padding.
        bytesConsumed = maybeSilenceBufferContentsSize - maybeSilenceBuffer.size / 2

        bytesToOutput = calculateShortenedSilenceLength(bytesConsumed)
        outputSilence(bytesToOutput, MUTE)
      }

      check(bytesConsumed % bytesPerFrame == 0) {
        "bytesConsumed is not aligned to frame size: $bytesConsumed"
      }
      check(sizeBeforeOutput >= bytesToOutput)

      maybeSilenceBufferContentsSize -= bytesConsumed
      maybeSilenceBufferStartIndex += bytesConsumed
      // The start index might wrap back around to the start of the buffer.
      maybeSilenceBufferStartIndex %= maybeSilenceBuffer.size

      outputSilenceFramesSinceNoise += bytesToOutput / bytesPerFrame
      val skipped = ((bytesConsumed - bytesToOutput) / bytesPerFrame).toLong()
      if (skipped > 0) {
        skippedFrames += skipped
        savedUs.addAndGet(skipped * C.MICROS_PER_SECOND / inputAudioFormat.sampleRate)
      }
    }
  }

  /**
   * The size a given number of bytes of silence should be shortened to: [silenceRetentionRatio] of
   * it until the maximum kept silence is reached, then only what is left up to
   * [maxSilenceToKeepDurationUs].
   */
  private fun calculateShortenedSilenceLength(silenceToShortenBytes: Int): Int {
    // Start skipping silence to keep the silence below MAX_SILENCE_DURATION_US long.
    val bytesNeededToReachMax =
      (durationUsToFrames(maxSilenceToKeepDurationUs) - outputSilenceFramesSinceNoise) *
        bytesPerFrame - maybeSilenceBuffer.size / 2

    check(bytesNeededToReachMax >= 0)

    return alignToBytePerFrameBoundary(
      min(silenceToShortenBytes * silenceRetentionRatio + .5f, bytesNeededToReachMax.toFloat()),
    )
  }

  /** Decreases [value] to the nearest multiple of [bytesPerFrame] (avoids rounding errors). */
  private fun alignToBytePerFrameBoundary(value: Int): Int = (value / bytesPerFrame) * bytesPerFrame

  private fun alignToBytePerFrameBoundary(value: Float): Int =
    alignToBytePerFrameBoundary(value.toInt())

  /** Copies elements from [data] into a new output buffer. */
  private fun outputRange(data: ByteArray, size: Int, rampType: Int) {
    require(size % bytesPerFrame == 0) { "byteOutput size is not aligned to frame size $size" }

    modifyVolume(data, size, rampType)
    replaceOutputBuffer(size).put(data, 0, size).flip()
  }

  /**
   * Copies [sizeToOutput] bytes from [maybeSilenceBuffer] (whose contents may wrap around) into
   * [contiguousOutputBuffer] (always from index 0), then outputs them. For [FADE_IN] the END of the
   * contents is kept (it pads the start of the next noise); otherwise the beginning is kept.
   */
  private fun outputSilence(sizeToOutput: Int, rampType: Int) {
    if (sizeToOutput == 0) {
      return
    }

    require(maybeSilenceBufferContentsSize >= sizeToOutput)

    if (rampType == FADE_IN) {
      // Keeps the end of the buffer because we are padding the start of the next chunk of noise.
      if (maybeSilenceBufferStartIndex + maybeSilenceBufferContentsSize <= maybeSilenceBuffer.size) {
        // ^0---^start---^end---^length
        System.arraycopy(
          maybeSilenceBuffer,
          maybeSilenceBufferStartIndex + maybeSilenceBufferContentsSize - sizeToOutput,
          contiguousOutputBuffer,
          0,
          sizeToOutput,
        )
      } else {
        // ^0---^end--^start---^length
        val sizeInUpperPartOfArray = maybeSilenceBuffer.size - maybeSilenceBufferStartIndex
        val sizeInLowerPartOfArray = maybeSilenceBufferContentsSize - sizeInUpperPartOfArray
        if (sizeInLowerPartOfArray >= sizeToOutput) {
          // We just need the lower part of the array.
          System.arraycopy(
            maybeSilenceBuffer,
            sizeInLowerPartOfArray - sizeToOutput,
            contiguousOutputBuffer,
            0,
            sizeToOutput,
          )
        } else {
          val sizeToOutputInUpperPart = sizeToOutput - sizeInLowerPartOfArray
          System.arraycopy(
            maybeSilenceBuffer,
            maybeSilenceBuffer.size - sizeToOutputInUpperPart,
            contiguousOutputBuffer,
            0,
            sizeToOutputInUpperPart,
          )

          // Copy everything from the lower part.
          System.arraycopy(
            maybeSilenceBuffer,
            0,
            contiguousOutputBuffer,
            sizeToOutputInUpperPart,
            sizeInLowerPartOfArray,
          )
        }
      }
    } else {
      if (maybeSilenceBufferStartIndex + sizeToOutput <= maybeSilenceBuffer.size) {
        // ^0---^start---^end---^length
        System.arraycopy(
          maybeSilenceBuffer,
          maybeSilenceBufferStartIndex,
          contiguousOutputBuffer,
          0,
          sizeToOutput,
        )
      } else {
        // ^0---^end (of content to output now)---^start---^length
        val sizeToCopyInUpperPartOfArray = maybeSilenceBuffer.size - maybeSilenceBufferStartIndex
        // Copy the upper part of the array.
        System.arraycopy(
          maybeSilenceBuffer,
          maybeSilenceBufferStartIndex,
          contiguousOutputBuffer,
          0,
          sizeToCopyInUpperPartOfArray,
        )
        val amountToCopyFromLowerPartOfArray = sizeToOutput - sizeToCopyInUpperPartOfArray
        System.arraycopy(
          maybeSilenceBuffer,
          0,
          contiguousOutputBuffer,
          sizeToCopyInUpperPartOfArray,
          amountToCopyFromLowerPartOfArray,
        )
      }
    }

    require(sizeToOutput % bytesPerFrame == 0) {
      "sizeToOutput is not aligned to frame size: $sizeToOutput"
    }
    check(maybeSilenceBufferStartIndex < maybeSilenceBuffer.size)

    outputRange(contiguousOutputBuffer, sizeToOutput, rampType)
  }

  /** Scales the samples in [sampleBuffer] for the given volume change type. */
  private fun modifyVolume(sampleBuffer: ByteArray, size: Int, volumeChangeType: Int) {
    if (volumeChangeType == DO_NOT_CHANGE_VOLUME) {
      return
    }

    // The 1.11.1 fix: fades progress per FRAME, so every channel of a frame gets the same gain.
    val lastFrameIdx = (size / bytesPerFrame) - 1
    var idx = 0
    while (idx < size) {
      val mostSignificantByte = sampleBuffer[idx + 1]
      val leastSignificantByte = sampleBuffer[idx]
      var sample = twoByteSampleToInt(mostSignificantByte, leastSignificantByte)

      val volumeModificationPercentage =
        when (volumeChangeType) {
          FADE_OUT -> calculateFadeOutPercentage(idx / bytesPerFrame, lastFrameIdx)
          FADE_IN -> calculateFadeInPercentage(idx / bytesPerFrame, lastFrameIdx)
          else -> minVolumeToKeepPercentageWhenMuting
        }

      sample = (sample * volumeModificationPercentage) / 100
      sampleIntToTwoBigEndianBytes(sampleBuffer, idx, sample)
      idx += 2
    }
  }

  private fun calculateFadeOutPercentage(value: Int, max: Int): Int {
    if (max == 0) {
      return minVolumeToKeepPercentageWhenMuting
    }
    return ((minVolumeToKeepPercentageWhenMuting - 100) * ((AVOID_TRUNCATION_FACTOR * value) / max)) /
      AVOID_TRUNCATION_FACTOR + 100
  }

  private fun calculateFadeInPercentage(value: Int, max: Int): Int {
    if (max == 0) {
      return 100
    }
    // In Long: (100 - min) * 1000 * value overflows an Int past ~23,860 frames, which the
    // narration defaults' fade (up to 187.5 ms) reaches above ~127 kHz (a 176.4 or 192 kHz
    // file got a garbage, often negative, gain at the end of every fade-in).
    return minVolumeToKeepPercentageWhenMuting +
      ((100 - minVolumeToKeepPercentageWhenMuting).toLong() * (AVOID_TRUNCATION_FACTOR.toLong() * value) / max /
        AVOID_TRUNCATION_FACTOR).toInt()
  }

  /** Copies the remaining bytes of [data] into a new output buffer. */
  private fun output(data: ByteBuffer) {
    replaceOutputBuffer(data.remaining()).put(data).flip()
  }

  /** The number of input frames in [durationUs] microseconds of audio. */
  private fun durationUsToFrames(durationUs: Long): Int =
    ((durationUs * inputAudioFormat.sampleRate) / C.MICROS_PER_SECOND).toInt()

  /**
   * The earliest byte position in [position, limit) of [buffer] that holds a noisy frame, or the
   * limit if there is none.
   */
  private fun findNoisePosition(buffer: ByteBuffer): Int {
    // The input is in ByteOrder.nativeOrder(), which is little endian on Android.
    var i = buffer.position() + 1
    while (i < buffer.limit()) {
      if (isNoise(buffer.get(i), buffer.get(i - 1))) {
        // Round to the start of the frame.
        return bytesPerFrame * (i / bytesPerFrame)
      }
      i += 2
    }
    return buffer.limit()
  }

  /**
   * The earliest byte position in [position, limit) of [buffer] such that every frame from there
   * to the limit is silent.
   */
  private fun findNoiseLimit(buffer: ByteBuffer): Int {
    // The input is in ByteOrder.nativeOrder(), which is little endian on Android.
    var i = buffer.limit() - 1
    while (i >= buffer.position()) {
      if (isNoise(buffer.get(i), buffer.get(i - 1))) {
        // Return the start of the next frame.
        return bytesPerFrame * (i / bytesPerFrame) + bytesPerFrame
      }
      i -= 2
    }
    return buffer.position()
  }

  /** Whether the two bytes are a signed 16-bit sample louder than [silenceThresholdLevel]. */
  private fun isNoise(mostSignificantByte: Byte, leastSignificantByte: Byte): Boolean =
    abs(twoByteSampleToInt(mostSignificantByte, leastSignificantByte)) > silenceThresholdLevel

  companion object {
    /*
     * Narration defaults. Spoken word has short, meaningful
     * pauses and quiet consonant tails, so these are gentler than Media3's.
     */

    /** ~-40 dBFS peak: a -38 dBFS consonant tail (~412) still counts as speech. */
    const val DEFAULT_SILENCE_THRESHOLD_LEVEL: Short = 330

    /** Pauses shorter than this are never touched; 150 ms is kept on each side of every word. */
    const val DEFAULT_MINIMUM_SILENCE_DURATION_US = 300_000L

    /** A quarter of what is beyond the minimum is kept. */
    const val DEFAULT_SILENCE_RETENTION_RATIO = 0.25f

    /** No pause is ever longer than 1 s after trimming. */
    const val DEFAULT_MAX_SILENCE_TO_KEEP_DURATION_US = 1_000_000L

    /** The trimmed part plays at 10% (true zero sounds like playback stopped). */
    const val DEFAULT_MIN_VOLUME_TO_KEEP_PERCENTAGE = 10

    /** State when the input is not silent. */
    private const val STATE_NOISY = 0

    /** State when the input has been silent and the silence is being shortened. */
    private const val STATE_SHORTENING_SILENCE = 1

    private const val FADE_OUT = 0
    private const val MUTE = 1
    private const val FADE_IN = 2
    private const val DO_NOT_CHANGE_VOLUME = 3

    /** Used with minVolumeToKeepPercentageWhenMuting to avoid integer round-off. */
    private const val AVOID_TRUNCATION_FACTOR = 1000

    private val EMPTY_BYTE_ARRAY = ByteArray(0)

    private fun twoByteSampleToInt(mostSignificantByte: Byte, leastSignificantByte: Byte): Int =
      (leastSignificantByte.toInt() and 0xFF) or (mostSignificantByte.toInt() shl 8)

    /** Writes [sample] as little-endian 16-bit bytes (the upstream name says big-endian; it isn't). */
    private fun sampleIntToTwoBigEndianBytes(byteArray: ByteArray, startIndex: Int, sample: Int) {
      // Avoid 16-bit integer overflow when writing back the manipulated data.
      if (sample >= Short.MAX_VALUE) {
        byteArray[startIndex] = 0xFF.toByte()
        byteArray[startIndex + 1] = 0x7F.toByte()
      } else if (sample <= Short.MIN_VALUE) {
        byteArray[startIndex] = 0x00.toByte()
        byteArray[startIndex + 1] = 0x80.toByte()
      } else {
        byteArray[startIndex] = (sample and 0xFF).toByte()
        byteArray[startIndex + 1] = (sample shr 8).toByte()
      }
    }
  }
}
