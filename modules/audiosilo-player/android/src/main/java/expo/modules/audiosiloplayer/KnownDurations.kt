package expo.modules.audiosiloplayer

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.extractor.ConstantBitrateSeekMap
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.extractor.text.SubtitleParser
import java.util.Collections
import kotlin.math.abs
import kotlin.math.roundToLong

/*
 * An MP3 with no Xing, VBRI or MLLT header (a VBR file written with `-write_xing 0`, or one a
 * tool stripped) gets Media3's constant-bitrate guess: Mp3Extractor (1.9.0) takes the FIRST
 * frame's bitrate as the whole file's. A VBR file that opens on a 160 kb/s frame and averages
 * 34 kb/s then reads as a fifth of its length (a 139 s file as 29.9 s), so a resume past that
 * landed in the next file, and a Retry there ended, and finished, the book.
 *
 * The server knows the file's length (its probe, the timeline the JS store reads), and every
 * queue item carries it (`MediaItems.KEY_FILE_DURATION`). So when Mp3Extractor falls back to a
 * constant-bitrate seek map whose length disagrees with the server's, the map is stretched onto
 * the server's length (the file's average bitrate, as a browser seeks such a file), and the
 * sample times after a seek are moved onto the same scale. Played from the start the times are
 * the extractor's own frame count, exact either way.
 *
 * Why not `Mp3Extractor.FLAG_ENABLE_INDEX_SEEKING`: in 1.9.0 it only replaces a seeker that is
 * NOT seekable, and the first-frame guess IS seekable whenever the length is known (a local file,
 * or a stream with a Content-Length, which is every file this server sends), so the flag changes
 * nothing here. Where it would apply (no length), every seek past the indexed part reads each
 * byte from the last indexed frame on: a resume 9 h into a streamed file downloads 9 h of audio
 * first. `FLAG_ENABLE_CONSTANT_BITRATE_SEEKING(_ALWAYS)` only decides what an unseekable or
 * length-less file gets, so neither reaches this case either.
 */

/** Each file's length as the server measured it, by the uri the engine loads (a stream url or a
 * download's file uri). Filled as the player builds an item's source, read as its extractor is
 * made. Bounded: an old queue's entries are dropped once [capacity] newer ones arrive. */
class KnownDurations(private val capacity: Int = 1024) {
  private val byUri: MutableMap<String, Long> = Collections.synchronizedMap(
    object : LinkedHashMap<String, Long>(16, 0.75f, true) {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?) = size > capacity
    },
  )

  /** Records [seconds] for [uri]; an unknown length (0, not finite) records nothing. */
  fun note(uri: String, seconds: Double) {
    if (seconds > 0 && seconds.isFinite()) byUri[uri] = (seconds * 1_000_000).roundToLong()
  }

  /** The server's length for [uri] in microseconds, else [C.TIME_UNSET]. */
  fun durationUs(uri: String): Long = byUri[uri] ?: C.TIME_UNSET
}

/** The player's media source factory with each item's server length noted for its extractor. */
class KnownDurationMediaSourceFactory(
  private val inner: MediaSource.Factory,
  private val known: KnownDurations,
) : MediaSource.Factory by inner {
  override fun createMediaSource(mediaItem: MediaItem): MediaSource {
    val uri = mediaItem.localConfiguration?.uri
    val seconds = MediaItems.entryOf(mediaItem)?.fileDuration ?: 0.0
    if (uri != null) known.note(uri.toString(), seconds)
    return inner.createMediaSource(mediaItem)
  }
}

/** [DefaultExtractorsFactory]'s extractors, its MP3 one held to the server's length. */
class KnownDurationExtractorsFactory(
  private val known: KnownDurations,
  private val inner: ExtractorsFactory = DefaultExtractorsFactory(),
) : ExtractorsFactory {
  override fun createExtractors(): Array<Extractor> = inner.createExtractors()

  override fun createExtractors(uri: Uri, responseHeaders: Map<String, List<String>>): Array<Extractor> =
    holdMp3To(inner.createExtractors(uri, responseHeaders), known.durationUs(uri.toString()))

  override fun setSubtitleParserFactory(factory: SubtitleParser.Factory): ExtractorsFactory = apply {
    inner.setSubtitleParserFactory(factory)
  }

  override fun experimentalSetCodecsToParseWithinGopSampleDependencies(codecs: Int): ExtractorsFactory = apply {
    inner.experimentalSetCodecsToParseWithinGopSampleDependencies(codecs)
  }

  companion object {
    /** [extractors] with each [Mp3Extractor] wrapped in a [KnownDurationExtractor], when the
     * length is known; the others (and all of them, unknown) as they are. */
    fun holdMp3To(extractors: Array<Extractor>, knownUs: Long): Array<Extractor> {
      if (knownUs <= 0) return extractors // C.TIME_UNSET included
      return Array(extractors.size) { i ->
        val e = extractors[i]
        if (e is Mp3Extractor) KnownDurationExtractor(e, knownUs) else e
      }
    }
  }
}

/**
 * Moves a constant-bitrate seek map, and the sample times that follow a seek through it, onto
 * the server's length (see the top of this file). Pure state, so the maths is tested on its own.
 */
class Retimer(private val knownUs: Long) {
  /** known / estimated, once the extractor's seek map has been seen; null = times untouched. */
  var scale: Double? = null
    private set
  private var decided = false
  private var anchorIn = C.TIME_UNSET
  private var anchorOut = 0L

  /** The seek map the player gets in place of the extractor's [map]. Decided on the first map
   * only: the extractor re-sends its constant-bitrate map at the end of the input (its data end
   * moved), which keeps the scale the samples were timed with. */
  fun seekMap(map: SeekMap): SeekMap {
    if (!decided) {
      decided = true
      scale = scaleFor(map, knownUs)
    }
    val s = scale ?: return map
    return if (map is ConstantBitrateSeekMap) ScaledSeekMap(map, s) else map
  }

  /** The extractor was seeked: the next sample's time anchors the new run. */
  fun onSeek() {
    anchorIn = C.TIME_UNSET
  }

  /** A sample's time on the server's scale. The first sample after a seek (or the first of the
   * file) is the extractor's estimate at that byte, scaled; the ones after it advance by the
   * extractor's own frame durations, which are exact. */
  fun sampleTimeUs(timeUs: Long): Long {
    val s = scale ?: return timeUs
    if (anchorIn == C.TIME_UNSET) {
      anchorIn = timeUs
      anchorOut = (timeUs * s).roundToLong()
    }
    return anchorOut + (timeUs - anchorIn)
  }

  fun durationUs(durationUs: Long): Long {
    val s = scale ?: return durationUs
    return if (durationUs == C.TIME_UNSET) durationUs else (durationUs * s).roundToLong()
  }

  companion object {
    /** Below this a constant-bitrate guess agrees with the server (a real CBR file): untouched. */
    const val AGREES = 0.001
    /** Outside these the server's length is the suspect one (a first frame is at most 10x a
     * speech file's average either way): untouched. */
    const val MIN_SCALE = 0.05
    const val MAX_SCALE = 20.0

    /** known / estimated for a seekable constant-bitrate [map] that disagrees with [knownUs],
     * else null (a header's exact map, an unknown length, or an agreeing guess). */
    fun scaleFor(map: SeekMap, knownUs: Long): Double? {
      if (map !is ConstantBitrateSeekMap || !map.isSeekable) return null
      val estimated = map.durationUs
      if (estimated <= 0 || knownUs <= 0) return null // C.TIME_UNSET included
      val s = knownUs.toDouble() / estimated
      if (abs(s - 1) <= AGREES || s < MIN_SCALE || s > MAX_SCALE) return null
      return s
    }
  }
}

/** [inner] with its times multiplied by [scale] (byte positions unchanged). */
class ScaledSeekMap(private val inner: SeekMap, private val scale: Double) : SeekMap {
  override fun isSeekable(): Boolean = inner.isSeekable

  override fun getDurationUs(): Long = (inner.durationUs * scale).roundToLong()

  override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints {
    val points = inner.getSeekPoints((timeUs / scale).roundToLong())
    return SeekMap.SeekPoints(scaled(points.first), scaled(points.second))
  }

  private fun scaled(p: SeekPoint) = SeekPoint((p.timeUs * scale).roundToLong(), p.position)
}

/** An MP3 extractor whose seek map and sample times follow the server's length ([Retimer]). */
class KnownDurationExtractor(private val inner: Extractor, knownUs: Long) : Extractor {
  private val retimer = Retimer(knownUs)

  override fun sniff(input: ExtractorInput): Boolean = inner.sniff(input)

  override fun getSniffFailureDetails() = inner.sniffFailureDetails

  override fun init(output: ExtractorOutput) = inner.init(RetimingOutput(output, retimer))

  override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int = inner.read(input, seekPosition)

  override fun seek(position: Long, timeUs: Long) {
    retimer.onSeek()
    inner.seek(position, timeUs)
  }

  override fun release() = inner.release()

  override fun getUnderlyingImplementation(): Extractor = inner.underlyingImplementation

  private class RetimingOutput(private val out: ExtractorOutput, private val retimer: Retimer) : ExtractorOutput {
    override fun track(id: Int, type: Int): TrackOutput = RetimingTrack(out.track(id, type), retimer)

    override fun endTracks() = out.endTracks()

    override fun seekMap(seekMap: SeekMap) = out.seekMap(retimer.seekMap(seekMap))
  }

  private class RetimingTrack(private val out: TrackOutput, private val retimer: Retimer) : TrackOutput {
    override fun durationUs(durationUs: Long) = out.durationUs(retimer.durationUs(durationUs))

    override fun format(format: Format) = out.format(format)

    override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int): Int =
      out.sampleData(input, length, allowEndOfInput, sampleDataPart)

    override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) =
      out.sampleData(data, length, sampleDataPart)

    override fun sampleMetadata(
      timeUs: Long,
      flags: Int,
      size: Int,
      offset: Int,
      cryptoData: TrackOutput.CryptoData?,
    ) = out.sampleMetadata(retimer.sampleTimeUs(timeUs), flags, size, offset, cryptoData)
  }
}
