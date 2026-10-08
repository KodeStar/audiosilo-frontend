package expo.modules.audiosiloplayer.effects

import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Voice Boost on synthetic PCM (stereo 44.1 kHz, the sink's 16-bit format). */
class VoiceBoostProcessorTest {
  private val rate = 44_100
  private val channels = 2
  private val chunk = 512 // frames per buffer, as small as a sink at high speed sends

  /** -1 dBFS in sample units, plus one for rounding. */
  private val ceiling = VoiceBoostProcessor.CEILING * 32768.0 + 1.0

  private fun boost(on: Boolean, highPass: Boolean = true): Pair<VoiceBoostProcessor, AtomicBoolean> {
    val switch = AtomicBoolean(on)
    val p = VoiceBoostProcessor(switch, highPass)
    p.configure(pcm16(rate, channels))
    p.flush()
    return p to switch
  }

  private fun dbfs(amplitude: Double) = 32768.0 * Math.pow(10.0, amplitude / 20.0)

  /** RMS in dBFS of the left channel over frames [from, to). */
  private fun rmsDb(pcm: ShortArray, from: Int, to: Int): Double {
    var sum = 0.0
    for (f in from until to) {
      val x = pcm[f * channels] / 32768.0
      sum += x * x
    }
    return 20.0 * log10(sqrt(sum / (to - from)))
  }

  @Test
  fun alwaysActiveSoTogglingNeverFlushes() {
    val (p, switch) = boost(on = false)
    assertTrue(p.isActive())
    switch.set(true)
    assertTrue(p.isActive())
    switch.set(false)
    assertTrue(p.isActive())
  }

  @Test
  fun offIsBitExact() {
    val input = PcmBuilder(rate, channels).tone(500.0, 220.0, dbfs(-3.0)).floor(200.0).word().build()
    val (p, _) = boost(on = false)
    assertArrayEquals(input, runProcessor(p, input, channels, chunk))
  }

  @Test
  fun loudPeaksStayUnderMinus1Dbfs() {
    // Room tone (the ramp-in happens here), then a sudden full-scale onset, a full-scale square
    // wave and loud speech: the onsets are what get past a compressor's 10 ms attack.
    val b = PcmBuilder(rate, channels).floor(100.0)
    b.tone(400.0, 1000.0, 32767.0)
    b.floor(50.0)
    b.tone(300.0, 150.0, 60000.0) // clipped to a square by the builder
    b.floor(50.0)
    b.word(voicedMs = 300.0).tone(300.0, 300.0, dbfs(-1.0))
    val input = b.build()
    val (p, _) = boost(on = true)
    val output = runProcessor(p, input, channels, chunk)
    assertEquals(input.size, output.size)
    val start = rate * 30 / 1000 * channels // after the 20 ms ramp
    var peak = 0
    for (i in start until output.size) peak = maxOf(peak, abs(output[i].toInt()))
    assertTrue("peak $peak <= ceiling $ceiling", peak <= ceiling)
    assertTrue("the loud parts are still loud ($peak)", peak > dbfs(-6.0))
  }

  @Test
  fun quietSpeechIsLiftedAndLoudSpeechIsTamed() {
    val second = rate
    // -36 dBFS: under the knee (-33 to -27), so only the +9 dB make-up applies.
    val quiet = PcmBuilder(rate, channels).tone(1000.0, 1000.0, dbfs(-36.0)).build()
    val (p1, _) = boost(on = true)
    val quietOut = runProcessor(p1, quiet, channels, chunk)
    val lift = rmsDb(quietOut, second / 2, second) - rmsDb(quiet, second / 2, second)
    assertEquals("quiet speech lifted by the make-up gain", 9.0, lift, 0.5)

    // -6 dBFS peak: 24 dB over the threshold -> 3:1 takes 16 dB, make-up gives 9 back.
    val loud = PcmBuilder(rate, channels).tone(1000.0, 1000.0, dbfs(-6.0)).build()
    val (p2, _) = boost(on = true)
    val loudOut = runProcessor(p2, loud, channels, chunk)
    val change = rmsDb(loudOut, second / 2, second) - rmsDb(loud, second / 2, second)
    assertEquals("loud speech brought down", -7.0, change, 0.75)
  }

  @Test
  fun liftAtTheThresholdIsAboutNineDb() {
    // The preset's headline number: speech peaking at the -30 dBFS threshold comes out ~8.5 dB
    // louder (+9 make-up, minus the knee's 0.5 dB).
    val second = rate
    val atThreshold = PcmBuilder(rate, channels).tone(1000.0, 1000.0, dbfs(-30.0)).build()
    val (p, _) = boost(on = true)
    val out = runProcessor(p, atThreshold, channels, chunk)
    val lift = rmsDb(out, second / 2, second) - rmsDb(atThreshold, second / 2, second)
    println("Voice Boost lift at -30 dBFS: %.2f dB".format(lift))
    assertEquals("lift at the threshold", 8.5, lift, 0.5)
  }

  @Test
  fun bypassIsBitExactAfterTheRamp() {
    val input = PcmBuilder(rate, channels).word().tone(600.0, 220.0, dbfs(-12.0)).word().floor(300.0).build()
    val switchAt = 20 * chunk // frame where it is turned off (a buffer boundary)
    val (p, switch) = boost(on = true)
    val output = runProcessor(p, input, channels, chunk) { frame ->
      if (frame >= switchAt) switch.set(false)
    }
    val rampEnd = switchAt + rate * 20 / 1000 + 1
    val inTail = input.copyOfRange(rampEnd * channels, input.size)
    val outTail = output.copyOfRange(rampEnd * channels, output.size)
    assertArrayEquals("bit-exact once the 20 ms ramp is over", inTail, outTail)
    // ...and it really was processing before the switch.
    var differs = 0
    for (i in 0 until switchAt * channels) if (input[i] != output[i]) differs++
    assertTrue("processed while on ($differs samples changed)", differs > switchAt)
  }

  @Test
  fun togglingRampsWithoutAClick() {
    // A steady -12 dBFS tone: its own largest sample-to-sample step is A x 2 pi f / fs. An
    // instant switch would jump by |x| x (gain - 1), up to thousands at the +9 dB start.
    val amplitude = dbfs(-12.0)
    val hz = 220.0
    val input = PcmBuilder(rate, channels).tone(3000.0, hz, amplitude).build()
    val onAt = 40 * chunk + 0
    val offAt = 160 * chunk
    val (p, switch) = boost(on = false)
    val output = runProcessor(p, input, channels, chunk) { frame ->
      switch.set(frame in onAt until offAt)
    }
    val naturalStep = amplitude * 2.0 * Math.PI * hz / rate
    val bound = 2.0 * naturalStep + 50.0
    var worst = 0
    for (f in 1 until output.size / channels) {
      val step = abs(output[f * channels] - output[(f - 1) * channels])
      worst = maxOf(worst, step)
    }
    assertTrue("largest step $worst <= $bound (natural ${naturalStep.toInt()})", worst <= bound)
    // The switch did something in between (otherwise the test proves nothing).
    val mid = (onAt + offAt) / 2
    val change = rmsDb(output, mid, mid + rate / 10) - rmsDb(input, mid, mid + rate / 10)
    assertTrue("boost audible while on ($change dB)", abs(change) > 1.0)
  }

  @Test
  fun compressorCurve() {
    assertEquals(0.0, VoiceBoostProcessor.compressorGainDb(-40.0), 1e-9)
    assertEquals(0.0, VoiceBoostProcessor.compressorGainDb(-33.0), 1e-9) // knee starts
    assertEquals(-0.5, VoiceBoostProcessor.compressorGainDb(-30.0), 1e-9) // mid-knee
    assertEquals(-4.0, VoiceBoostProcessor.compressorGainDb(-24.0), 1e-9) // 6 over, 3:1
    assertEquals(-20.0, VoiceBoostProcessor.compressorGainDb(0.0), 1e-9)
  }
}
