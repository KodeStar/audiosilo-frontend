package expo.modules.audiosiloplayer.effects

import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The vendored silence skipper with the narration defaults, on synthetic narration: words (a
 * voiced part + a -38 dBFS sibilant tail) separated by pauses of 100, 250, 300, 800 and 4000 ms
 * over a room-tone floor below the threshold. Stereo 44.1 kHz, which is where 1.5.1's
 * frames-as-bytes buffer (androidx/media#3271) kept a quarter of the padding.
 */
class NarrationSilenceProcessorTest {
  private val rate = 44_100
  private val channels = 2
  private val threshold = NarrationSilenceProcessor.DEFAULT_SILENCE_THRESHOLD_LEVEL.toInt()

  private val pauses = doubleArrayOf(100.0, 250.0, 300.0, 800.0, 4000.0)

  /** Pause (ms) -> what the contract says survives: under 300 ms all of it; else
   * 300 + 0.25 x (pause - 300), at most 1000. */
  private fun expectedKeptMs(pauseMs: Double): Double =
    if (pauseMs <= 300.0) pauseMs else minOf(1000.0, 300.0 + 0.25 * (pauseMs - 300.0))

  private fun narration(): ShortArray {
    val b = PcmBuilder(rate, channels).floor(50.0).word()
    for (p in pauses) b.floor(p).word()
    return b.floor(50.0).build()
  }

  private data class Run(val start: Int, val end: Int) // frames, inclusive

  /** Words = runs of frames with a sample above the threshold, merged across < 20 ms gaps. */
  private fun words(pcm: ShortArray): List<Run> {
    val frames = pcm.size / channels
    val mergeGap = rate / 50
    val runs = ArrayList<Run>()
    var start = -1
    var last = -1
    for (f in 0 until frames) {
      var noisy = false
      for (ch in 0 until channels) if (abs(pcm[f * channels + ch].toInt()) > threshold) noisy = true
      if (!noisy) continue
      if (start >= 0 && f - last > mergeGap) {
        runs.add(Run(start, last))
        start = f
      } else if (start < 0) {
        start = f
      }
      last = f
    }
    if (start >= 0) runs.add(Run(start, last))
    return runs
  }

  private fun process(
    input: ShortArray,
    chunkFrames: Int,
    savedUs: AtomicLong = AtomicLong(),
  ): Pair<NarrationSilenceProcessor, ShortArray> {
    val p = NarrationSilenceProcessor(savedUs = savedUs)
    p.setEnabled(true)
    p.configure(pcm16(rate, channels))
    p.flush()
    assertTrue(p.isActive())
    return p to runProcessor(p, input, channels, chunkFrames)
  }

  private fun ms(frames: Int) = frames * 1000.0 / rate

  @Test
  fun everyWordSurvivesBitExactIncludingItsQuietTail() {
    val input = narration()
    for (chunk in intArrayOf(1024, 777, 8192)) {
      val (_, output) = process(input, chunk)
      val inWords = words(input)
      val outWords = words(output)
      assertEquals("chunk $chunk: word count", pauses.size + 1, inWords.size)
      assertEquals("chunk $chunk: word count", inWords.size, outWords.size)
      for (i in inWords.indices) {
        val a = inWords[i]
        val b = outWords[i]
        assertEquals("chunk $chunk word $i length", a.end - a.start, b.end - b.start)
        val inSlice = input.copyOfRange(a.start * channels, (a.end + 1) * channels)
        val outSlice = output.copyOfRange(b.start * channels, (b.end + 1) * channels)
        assertArrayEquals("chunk $chunk word $i samples", inSlice, outSlice)
      }
    }
  }

  @Test
  fun pausesAreShortenedAsTheContractComputes() {
    val input = narration()
    for (chunk in intArrayOf(1024, 777, 8192)) {
      val (_, output) = process(input, chunk)
      val inWords = words(input)
      val outWords = words(output)
      for (i in pauses.indices) {
        val inGap = ms(inWords[i + 1].start - inWords[i].end - 1)
        val outGap = ms(outWords[i + 1].start - outWords[i].end - 1)
        val expected = expectedKeptMs(inGap)
        assertEquals("chunk $chunk pause ${pauses[i]} ms (in $inGap) kept", expected, outGap, 3.0)
      }
    }
  }

  @Test
  fun pausesUnder300MsAreUntouched() {
    val input = narration()
    val (_, output) = process(input, 1024)
    val inWords = words(input)
    val outWords = words(output)
    for (i in 0..1) { // the 100 ms and 250 ms pauses
      val inSlice = input.copyOfRange((inWords[i].end + 1) * channels, inWords[i + 1].start * channels)
      val outSlice = output.copyOfRange((outWords[i].end + 1) * channels, outWords[i + 1].start * channels)
      assertArrayEquals("pause ${pauses[i]} ms bit-exact", inSlice, outSlice)
    }
  }

  @Test
  fun keeps150MsOfTheRealPauseOnEachSideOfEveryWord() {
    val input = narration()
    val (_, output) = process(input, 1024)
    val inWords = words(input)
    val outWords = words(output)
    val edge = rate * 150 / 1000
    for (i in 2 until pauses.size) { // 300, 800, 4000 ms: the ones that are faded/shortened
      // After the word: the room tone that followed it, fading out from full level.
      checkFaded(
        input, inWords[i].end + 1, output, outWords[i].end + 1, edge,
        nearWordMin = 0.95, farMax = 0.2, label = "after word $i",
      )
      // Before the next word: the room tone that preceded it, fading in to full level.
      checkFaded(
        input, inWords[i + 1].start - edge, output, outWords[i + 1].start - edge, edge,
        nearWordMin = 0.95, farMax = 0.25, label = "before word ${i + 1}", fadingIn = true,
      )
    }
  }

  /**
   * [n] frames of [output] from [outStart] are [input]'s frames from [inStart] times one gain per
   * frame (same on every channel: the per-frame fade fix), between 9% and 100%; full near the
   * word, low at the far end.
   */
  private fun checkFaded(
    input: ShortArray,
    inStart: Int,
    output: ShortArray,
    outStart: Int,
    n: Int,
    nearWordMin: Double,
    farMax: Double,
    label: String,
    fadingIn: Boolean = false,
  ) {
    var nearGain = Double.NaN
    var farGain = Double.NaN
    for (j in 0 until n) {
      var frameGain = Double.NaN
      for (ch in 0 until channels) {
        val x = input[(inStart + j) * channels + ch].toInt()
        val y = output[(outStart + j) * channels + ch].toInt()
        if (abs(x) < 100) {
          assertTrue("$label frame $j: |y| <= |x|", abs(y) <= abs(x))
          continue
        }
        val g = y.toDouble() / x
        assertTrue("$label frame $j ch $ch gain $g in [0.09, 1]", g in 0.085..1.0)
        if (!frameGain.isNaN()) {
          assertEquals("$label frame $j: one gain per frame", frameGain, g, 0.025)
        }
        frameGain = g
      }
      if (frameGain.isNaN()) continue
      val nearWord = if (fadingIn) j >= n - 200 else j < 200
      val farFromWord = if (fadingIn) j < 200 else j >= n - 200
      if (nearWord) nearGain = if (nearGain.isNaN()) frameGain else minOf(nearGain, frameGain)
      if (farFromWord) farGain = if (farGain.isNaN()) frameGain else maxOf(farGain, frameGain)
    }
    assertTrue("$label: full level next to the word ($nearGain)", nearGain >= nearWordMin)
    assertTrue("$label: faded away from the word ($farGain)", farGain <= farMax)
  }

  @Test
  fun theMonotonicCounterEqualsWhatWasRemoved() {
    val input = narration()
    val shared = AtomicLong()
    val (p, output) = process(input, 1024, shared)
    val removedFrames = (input.size - output.size) / channels
    assertTrue("something was removed", removedFrames > 0)
    assertEquals(removedFrames.toLong(), p.getSkippedFrames())
    val expectedSeconds = removedFrames.toDouble() / rate
    assertEquals(expectedSeconds, shared.get() / 1e6, 0.001)
    // ~ (800 - 425) + (4000 - 1000) ms.
    assertEquals(3.375, shared.get() / 1e6, 0.02)

    // A flush (a seek) resets the sink-facing count but never the monotonic one.
    val savedBeforeFlush = shared.get()
    p.flush()
    assertEquals(0L, p.getSkippedFrames())
    assertEquals(savedBeforeFlush, shared.get())

    // A second processor sharing the process-wide counter adds to it.
    val (_, output2) = process(input, 777, shared)
    val removed2 = (input.size - output2.size) / channels
    assertEquals((removedFrames + removed2).toDouble() / rate, shared.get() / 1e6, 0.002)
  }

  @Test
  fun disabledIsInactiveAndTheChainWiresTheSwitch() {
    val chain = AudiosiloAudioChain()
    chain.silence.configure(pcm16(rate, channels))
    assertFalse(chain.silence.isActive())
    assertTrue(chain.applySkipSilenceEnabled(true))
    chain.silence.configure(pcm16(rate, channels))
    assertTrue(chain.silence.isActive())
    assertEquals(0L, chain.getSkippedOutputFrameCount())
    assertTrue(chain.getAudioProcessors()[0] === chain.silence)
    assertTrue(chain.getAudioProcessors()[1] === chain.sonic)
    assertTrue(chain.getAudioProcessors()[2] === chain.boost)
    assertFalse(chain.applySkipSilenceEnabled(false))
  }
}
