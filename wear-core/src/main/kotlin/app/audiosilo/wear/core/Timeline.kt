// The whole-book timeline, a port of targets/watch/Core/Timeline.swift (itself the phone's
// `src/playback/book-queue.ts`, CONVENTIONS.md "Whole-book timeline"): each distinct audio file is
// one track, chapters are markers laid over one timeline of summed file durations, and positions
// are whole-book seconds. Keep the three in step; the vectors in the tests are book-queue.test.ts's.
package app.audiosilo.wear.core

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlinx.serialization.Serializable

/** Treat within 5 s of the end as finished. */
const val FINISHED_TOLERANCE: Double = 5.0

/** Default length (seconds) of the chapters made up for a long, chapterless single file. */
const val DEFAULT_VIRTUAL_CHAPTER_INTERVAL: Double = 30.0 * 60

/** One distinct audio file of a book, in play order. */
@Serializable data class FileSpec(val path: String, val duration: Double, val size: Long)

/** A whole-book position as a track index and the seconds into it. */
data class Located(val index: Int, val positionInTrack: Double)

/** The server's file list for a book (the chapters response's, else the book's). */
private fun bookFileList(book: Book, chapterData: ChaptersResponse?): List<BookFile> {
  val files = chapterData?.files
  if (!files.isNullOrEmpty()) return files
  return book.files ?: emptyList()
}

/**
 * The distinct audio files of a book in play order: the explicit file list by `seq`, else the
 * files the chapters name, else the book path itself. Never a folder path.
 */
fun bookFileSpecs(book: Book, chapterData: ChaptersResponse? = null): List<FileSpec> {
  val files = bookFileList(book, chapterData)
  if (files.isNotEmpty()) {
    // sortedBy is stable: equal `seq`s keep their order.
    return files.sortedBy { it.seq }.map { FileSpec(it.relPath, it.duration, it.size) }
  }
  val raw = chapterData?.chapters ?: book.chapters ?: emptyList()
  if (raw.isNotEmpty()) {
    return distinctFilesFromChapters(raw).map { FileSpec(it.first, it.second, 0) }
  }
  return listOf(FileSpec(book.relPath, book.duration, book.size ?: 0))
}

/** Distinct files named by the chapters, in first-seen order, each lasting its largest chapter end. */
private fun distinctFilesFromChapters(chapters: List<Chapter>): List<Pair<String, Double>> {
  val durations = LinkedHashMap<String, Double>()
  for (ch in chapters) durations[ch.filePath] = max(durations[ch.filePath] ?: 0.0, ch.end)
  return durations.map { it.key to it.value }
}

/**
 * A chapter's whole-book start: the summed positive durations of the files before it plus its
 * in-file start. Located by `file_path`, else a valid `file_index`, else 0 files before (never the
 * server's `book_offset`, which some books send as 0 for every chapter).
 */
fun chapterBookOffset(files: List<FileSpec>, ch: Chapter): Double {
  val byPath = files.indexOfFirst { it.path == ch.filePath }
  val inRange = ch.fileIndex >= 0 && ch.fileIndex < files.size
  val upto = if (byPath >= 0) byPath else if (inRange) ch.fileIndex else 0
  var acc = 0.0
  for (i in 0 until min(upto, files.size)) if (files[i].duration > 0) acc += files[i].duration
  return acc + ch.start
}

/**
 * Evenly spaced chapters for a long chapterless single file (`ceil(total / interval)` of them, the
 * last ending at `total`); empty below 1.5 intervals.
 */
fun synthesizeChapters(
  filePath: String,
  total: Double,
  interval: Double = DEFAULT_VIRTUAL_CHAPTER_INTERVAL,
): List<Chapter> {
  if (interval <= 0 || total <= interval * 1.5) return emptyList()
  val count = ceil(total / interval).toInt()
  return (0 until count).map { i ->
    val start = i * interval
    Chapter(i, "", 0, filePath, start, min(start + interval, total), start)
  }
}

/** Where a chapter ends on the book timeline (`end` before `start` is a chapter of no length). */
fun chapterEndPosition(ch: Chapter): Double = ch.bookOffset + max(0.0, ch.end - ch.start)

/** The sleep timer's end of chapter: the chapter, its end on the timeline, wall seconds to it. */
data class ChapterEnd(val chapter: Chapter, val endPosition: Double, val untilEnd: Double)

/** The nearest chapter end more than `minSeconds` of wall clock ahead; null when none is. */
fun nextChapterEnd(
  chapters: List<Chapter>,
  position: Double,
  rate: Double,
  minSeconds: Double,
): ChapterEnd? {
  var nearest: ChapterEnd? = null
  for (ch in chapters) {
    val end = chapterEndPosition(ch)
    val until = wallClockSeconds(end - position, rate)
    if (until > minSeconds && (nearest == null || end < nearest.endPosition)) {
      nearest = ChapterEnd(ch, end, until)
    }
  }
  return nearest
}

/** Content seconds as wall-clock seconds at `rate` (rate.ts's `wallClockSeconds`). */
fun wallClockSeconds(contentSeconds: Double, rate: Double): Double =
  if (rate > 0 && rate.isFinite()) contentSeconds / rate else contentSeconds

/** A whole-book position as (track index, seconds into it), over the tracks' `offsets`. */
fun locateIn(offsets: List<Double>, position: Double): Located {
  var index = 0
  for ((i, o) in offsets.withIndex()) {
    if (position >= o) index = i else break
  }
  val start = offsets.getOrNull(index) ?: 0.0
  return Located(index, max(0.0, position - start))
}

/** (track index, seconds into it) as a whole-book position. */
fun toBookPosition(offsets: List<Double>, index: Int, positionInTrack: Double): Double =
  (offsets.getOrNull(index) ?: 0.0) + positionInTrack

/** A book's playable timeline. */
data class Timeline(
  val files: List<FileSpec>,
  /** Whole-book start (seconds) of each file. */
  val offsets: List<Double>,
  /** The timeline's length: the book's, the files' summed, or the furthest chapter end. */
  val total: Double,
  /**
   * The audio's own length: every file's duration summed, from the server's file list; 0 when
   * unknown (estimated from the chapters, or a file without one). A span event's `duration`.
   */
  val audio: Double,
  val chapters: List<Chapter>,
  val syntheticChapters: Boolean,
) {
  /** A whole-book position as (file index, seconds into it). */
  fun locate(position: Double): Located = locateIn(offsets, position)

  /** (file index, seconds into it) as a whole-book position. */
  fun bookPosition(index: Int, positionInTrack: Double): Double =
    toBookPosition(offsets, index, positionInTrack)

  /**
   * A place in the book as a span end (its file and seconds in it), null when it is not a number
   * (an engine that reports NaN never puts one in a span).
   */
  fun spanEnd(index: Int, positionInTrack: Double): SpanEnd? {
    val pos = bookPosition(index, positionInTrack)
    if (!pos.isFinite() || !positionInTrack.isFinite()) return null
    val file = files.getOrNull(index)?.path
    return SpanEnd(max(0.0, pos), file, if (file == null) null else max(0.0, positionInTrack))
  }

  /**
   * Where a saved place resumes: in its file at its own seconds when the book still has the file
   * (clamped to the file's length), else by the whole-book position (fe#188).
   */
  fun resumePlace(position: Double, file: String?, filePos: Double?): Located {
    if (file != null && filePos != null && filePos.isFinite()) {
      val i = files.indexOfFirst { it.path == file }
      if (i >= 0) {
        val d = files[i].duration
        return Located(i, max(0.0, if (d > 0) min(filePos, d) else filePos))
      }
    }
    return locate(position)
  }

  companion object {
    fun of(
      book: Book,
      chapters: ChaptersResponse? = null,
      virtualChapterInterval: Double = DEFAULT_VIRTUAL_CHAPTER_INTERVAL,
    ): Timeline {
      val raw = chapters?.chapters ?: book.chapters ?: emptyList()
      val specs = bookFileSpecs(book, chapters)
      val offsets = ArrayList<Double>(specs.size)
      var acc = 0.0
      for (s in specs) {
        offsets.add(acc)
        if (s.duration > 0) acc += s.duration
      }
      val laid = raw.map { it.copy(bookOffset = chapterBookOffset(specs, it)) }
      val furthest = laid.fold(0.0) { m, c -> max(m, chapterEndPosition(c)) }
      val total = maxOf(if (book.duration > 0) book.duration else 0.0, acc, furthest)
      val estimated = bookFileList(book, chapters).isEmpty() && raw.isNotEmpty()
      val audio = if (!estimated && specs.all { it.duration > 0 }) acc else 0.0
      val synthetic =
        if (specs.size == 1 && laid.size <= 1) {
          synthesizeChapters(specs[0].path, total, virtualChapterInterval)
        } else {
          emptyList()
        }
      return Timeline(
        files = specs,
        offsets = offsets,
        total = total,
        audio = audio,
        chapters = synthetic.ifEmpty { laid },
        syntheticChapters = synthetic.isNotEmpty(),
      )
    }
  }
}
