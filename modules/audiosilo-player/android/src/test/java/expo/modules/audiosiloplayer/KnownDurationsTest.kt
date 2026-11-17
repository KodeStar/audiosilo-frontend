package expo.modules.audiosiloplayer

import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.extractor.ConstantBitrateSeekMap
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp3.Mp3Extractor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A header-less VBR MP3 made in the test (no encoder needed: the extractor reads frame headers
 * and sizes only): MPEG-1 Layer III, 44.1 kHz mono, a first frame at 160 kb/s, then 32 kb/s
 * frames. Media3's first-frame guess reads it as about a fifth of its length, as it read the
 * R1-R3 fixture (a 139 s file as 29.9 s).
 */
class KnownDurationsTest {
  private val frameUs = 1152 * 1_000_000.0 / 44100 // one MPEG-1 Layer III frame at 44.1 kHz

  private fun frame(bitrateIndex: Int, bytes: Int): ByteArray {
    val f = ByteArray(bytes)
    f[0] = 0xFF.toByte()
    f[1] = 0xFB.toByte() // MPEG-1, Layer III, no CRC
    f[2] = (bitrateIndex shl 4).toByte() // 44.1 kHz, no padding
    f[3] = 0xC0.toByte() // mono
    return f
  }

  /** [frames] frames: the first at 160 kb/s (522 bytes), the rest at 32 kb/s (104 bytes). */
  private fun vbr(frames: Int): ByteArray = frame(10, 522) + cbr(frames - 1)

  /** Every frame at 32 kb/s: a real constant-bitrate file. */
  private fun cbr(frames: Int): ByteArray {
    val f = frame(1, 104)
    return ByteArray(f.size * frames) { f[it % f.size] }
  }

  private class Reader(private val bytes: ByteArray, private var pos: Int) : DataReader {
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      if (pos >= bytes.size) return C.RESULT_END_OF_INPUT
      val n = minOf(length, bytes.size - pos)
      System.arraycopy(bytes, pos, buffer, offset, n)
      pos += n
      return n
    }
  }

  private class Track : TrackOutput {
    val times = ArrayList<Long>()

    override fun format(format: Format) {}

    override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int): Int {
      val n = input.read(ByteArray(length), 0, length)
      return if (n == C.RESULT_END_OF_INPUT && allowEndOfInput) C.RESULT_END_OF_INPUT else n
    }

    override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) = data.skipBytes(length)

    override fun sampleMetadata(timeUs: Long, flags: Int, size: Int, offset: Int, cryptoData: TrackOutput.CryptoData?) {
      times.add(timeUs)
    }
  }

  private class Output : ExtractorOutput {
    val track = Track()
    val seekMaps = ArrayList<SeekMap>()
    /** Each map's duration as it was sent (an index seeker's grows in place). */
    val durations = ArrayList<Long>()

    override fun track(id: Int, type: Int): TrackOutput = track

    override fun endTracks() {}

    override fun seekMap(seekMap: SeekMap) {
      seekMaps.add(seekMap)
      durations.add(seekMap.durationUs)
    }
  }

  /** Runs [extractor] over [bytes] from [from] until the end, or [maxSamples] samples. */
  private fun run(
    extractor: Extractor,
    bytes: ByteArray,
    output: Output,
    from: Long = 0,
    lengthKnown: Boolean = true,
    maxSamples: Int = Int.MAX_VALUE,
  ) {
    val length = if (lengthKnown) bytes.size.toLong() else C.LENGTH_UNSET.toLong()
    var input = DefaultExtractorInput(Reader(bytes, from.toInt()), from, length)
    val holder = PositionHolder()
    val start = output.track.times.size
    while (output.track.times.size - start < maxSamples) {
      when (extractor.read(input, holder)) {
        Extractor.RESULT_END_OF_INPUT -> return
        Extractor.RESULT_SEEK -> input = DefaultExtractorInput(Reader(bytes, holder.position.toInt()), holder.position, length)
      }
    }
  }

  private fun extract(extractor: Extractor, bytes: ByteArray, lengthKnown: Boolean = true): Output {
    val out = Output()
    extractor.init(out)
    run(extractor, bytes, out, lengthKnown = lengthKnown)
    return out
  }

  private val frames = 1000
  private val trueUs = (frames * frameUs).toLong() // 26.12 s
  private val guessUs = ((522 + (frames - 1) * 104) * 8 * 1_000_000L) / 160_000 // 5.22 s

  @Test fun media3GuessesAHeaderlessVbrFileFromItsFirstFrame() {
    val out = extract(Mp3Extractor(), vbr(frames))
    assertEquals(guessUs.toDouble(), out.seekMaps.first().durationUs.toDouble(), 30_000.0)
    // Played from the start the sample times are the frame count: exact, past the guess.
    assertEquals(trueUs - frameUs, out.track.times.last().toDouble(), 1_000.0)
  }

  @Test fun indexSeekingChangesNothingWhenTheLengthIsKnown() {
    // FLAG_ENABLE_INDEX_SEEKING only replaces an unseekable seeker; the first-frame guess is
    // seekable whenever the input has a length (a local file, a stream with Content-Length).
    val out = extract(Mp3Extractor(Mp3Extractor.FLAG_ENABLE_INDEX_SEEKING), vbr(frames))
    assertEquals(guessUs.toDouble(), out.seekMaps.first().durationUs.toDouble(), 30_000.0)
  }

  @Test fun indexSeekingAppliesOnlyWithoutALengthAndKnowsTheLengthOnlyAtTheEnd() {
    val out = extract(Mp3Extractor(Mp3Extractor.FLAG_ENABLE_INDEX_SEEKING), vbr(frames), lengthKnown = false)
    assertEquals(C.TIME_UNSET, out.durations.first())
    assertEquals(trueUs.toDouble(), out.durations.last().toDouble(), 1_000.0)
  }

  @Test fun heldToTheServersLength() {
    val out = extract(KnownDurationExtractor(Mp3Extractor(), trueUs), vbr(frames))
    assertEquals(trueUs.toDouble(), out.seekMaps.first().durationUs.toDouble(), 30_000.0)
    // The re-sent map at the end of the input keeps the same scale.
    assertEquals(trueUs.toDouble(), out.seekMaps.last().durationUs.toDouble(), 30_000.0)
    // Played from the start: the extractor's own exact times, untouched.
    val plain = extract(Mp3Extractor(), vbr(frames))
    assertEquals(plain.track.times, out.track.times)
  }

  @Test fun aSeekLandsOnTheServersScaleAndPlaysOnInFrameSteps() {
    val bytes = vbr(frames)
    val extractor = KnownDurationExtractor(Mp3Extractor(), trueUs)
    val out = Output()
    extractor.init(out)
    run(extractor, bytes, out, maxSamples = 1) // reads the header and sends the seek map
    val target = 13_000_000L
    val point = out.seekMaps.last().getSeekPoints(target).first
    extractor.seek(point.position, point.timeUs)
    val before = out.track.times.size
    run(extractor, bytes, out, from = point.position, maxSamples = 5)
    val after = out.track.times.subList(before, out.track.times.size)
    // The map's point is the guess's frame at or before the target (522 bytes of the guess are
    // 26 ms, five times that on the server's scale), and the first sample there reads as that
    // point's time, never the guess's 13 s (65 s of real audio).
    assertTrue(point.timeUs <= target && target - point.timeUs < 5 * frameUs)
    assertEquals(point.timeUs.toDouble(), after.first().toDouble(), 2 * frameUs)
    // About where the audio is (the average bitrate's error: the big first frame).
    val realUs = ((point.position - 522) / 104 + 1) * frameUs
    assertEquals(realUs, after.first().toDouble(), 5 * frameUs)
    for (i in 1 until after.size) assertEquals(frameUs, (after[i] - after[i - 1]).toDouble(), 1.0)
  }

  @Test fun aRealConstantBitrateFileIsLeftAsItIs() {
    val bytes = cbr(frames)
    val plain = extract(Mp3Extractor(), bytes)
    // A server's length within 0.1 % of the guess (here 0.04 %): untouched.
    val held = extract(KnownDurationExtractor(Mp3Extractor(), plain.seekMaps.first().durationUs + 10_000), bytes)
    assertEquals(plain.seekMaps.first().durationUs, held.seekMaps.first().durationUs)
    assertEquals(plain.track.times, held.track.times)
  }

  @Test fun scaleOnlyForASeekableConstantBitrateGuessThatDisagrees() {
    val guess = ConstantBitrateSeekMap(104_418, 0, 160_000, 522) // 5.22 s
    assertEquals(5.0, Retimer.scaleFor(guess, 26_100_000)!!, 0.01)
    assertNull(Retimer.scaleFor(guess, 5_221_000)) // agrees within 0.1 %
    assertNull(Retimer.scaleFor(guess, 0))
    assertNull(Retimer.scaleFor(guess, 5_221_000_000)) // 1000x: the server's length is the suspect
    assertNull(Retimer.scaleFor(SeekMap.Unseekable(5_000_000), 26_100_000)) // not a guess
    assertNull(Retimer.scaleFor(ConstantBitrateSeekMap(C.LENGTH_UNSET.toLong(), 0, 160_000, 522), 26_100_000))
  }

  @Test fun anUnscaledRetimerPassesEverythingThrough() {
    val r = Retimer(26_100_000)
    val header = SeekMap.Unseekable(26_000_000)
    assertSame(header, r.seekMap(header))
    assertEquals(123L, r.sampleTimeUs(123))
    // Decided on the first map only.
    val guess = ConstantBitrateSeekMap(104_418, 0, 160_000, 522)
    assertSame(guess, r.seekMap(guess))
  }

  @Test fun sampleTimesAnchorOnTheFirstSampleAfterEachSeek() {
    val r = Retimer(26_100_000)
    r.seekMap(ConstantBitrateSeekMap(104_418, 0, 160_000, 522))
    val s = r.scale!!
    assertEquals(0L, r.sampleTimeUs(0))
    assertEquals(26_122L, r.sampleTimeUs(26_122))
    r.onSeek()
    assertEquals((2_600_000 * s).toLong().toDouble(), r.sampleTimeUs(2_600_000).toDouble(), 1.0)
    val anchored = r.sampleTimeUs(2_600_000 + 26_122) - r.sampleTimeUs(2_600_000 + 0)
    assertTrue(anchored in 26_121..26_123)
  }

  @Test fun onlyTheMp3ExtractorIsWrappedAndOnlyWithAKnownLength() {
    val mp3 = Mp3Extractor()
    val other = KnownDurationExtractor(Mp3Extractor(), 1) // any other Extractor
    val wrapped = KnownDurationExtractorsFactory.holdMp3To(arrayOf(other, mp3), 26_100_000)
    assertSame(other, wrapped[0])
    assertTrue(wrapped[1] is KnownDurationExtractor)
    assertSame(mp3, wrapped[1].underlyingImplementation)
    val unknown = arrayOf<Extractor>(mp3)
    assertSame(unknown, KnownDurationExtractorsFactory.holdMp3To(unknown, C.TIME_UNSET))
  }

  @Test fun knownDurationsRecordsOnlyARealLengthAndStaysBounded() {
    val k = KnownDurations(capacity = 2)
    k.note("a", 0.0)
    k.note("b", Double.NaN)
    assertEquals(C.TIME_UNSET, k.durationUs("a"))
    k.note("a", 139.42)
    assertEquals(139_420_000L, k.durationUs("a"))
    k.note("c", 1.0)
    k.note("d", 1.0)
    assertEquals(C.TIME_UNSET, k.durationUs("a")) // the oldest gave way
  }
}
