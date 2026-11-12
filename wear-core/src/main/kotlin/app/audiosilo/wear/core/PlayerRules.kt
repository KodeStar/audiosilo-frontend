// The player's pure rules, a port of targets/watch/Core/PlayerRules.swift: speed, skips, chapter
// moves, the Now Playing times and where a book resumes. The engine (wear's playback/) only
// carries them out, so the positions it plays and reports are the ones tested here. Every position
// is whole-book seconds (the Timeline's), never a file's.
package app.audiosilo.wear.core

import java.io.File
import java.time.Instant
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/** Swift's `rounded()`: to the nearest, halves away from zero (Kotlin's `round` is half-even). */
fun roundHalfAway(x: Double): Double = if (x >= 0) floor(x + 0.5) else -floor(-x + 0.5)

object PlaybackSpeed {
  /** The product's range and presets (the phone's `rate.ts` and `speed-model.ts`). */
  const val MIN: Double = 0.5
  const val MAX: Double = 2.0
  val PRESETS: List<Double> = listOf(0.8, 1.0, 1.1, 1.2, 1.25, 1.3, 1.5, 2.0)

  /** A speed inside the range; anything that is not a number is 1. */
  fun clamp(rate: Double): Double {
    if (!rate.isFinite() || rate <= 0) return 1.0
    return min(MAX, max(MIN, rate))
  }

  /**
   * The speed a book plays at when it loads: its own saved speed when it has one, else the
   * listener's default, in the range (the phone's `bookSpeed`: a 3x saved elsewhere plays at 2x).
   */
  fun book(saved: Double?, defaultRate: Double): Double {
    if (saved != null && saved > 0) return clamp(saved)
    return clamp(if (defaultRate > 0) defaultRate else 1.0)
  }

  /** A speed as it reads on a button: "1x", "1.25x". */
  fun label(rate: Double): String = number(rate) + "x"

  /** A speed as a sentence says it, the phone's `formatSpeed`: "2×", "1.25×". */
  fun sentenceLabel(rate: Double): String = number(rate) + "×"

  /** Whether a speed reads as normal speed (the phone's `isNormalSpeed`): two decimals, as shown. */
  fun isNormal(rate: Double): Boolean = roundHalfAway(clamp(rate) * 100) == 100.0

  private fun number(rate: Double): String {
    val r = roundHalfAway(clamp(rate) * 100) / 100
    return if (r == roundHalfAway(r)) r.toInt().toString() else r.toString()
  }
}

/** The two figures beside the bar, in whole seconds. */
data class Figures(val elapsed: Double, val left: Double)

object Skips {
  /** The phone's defaults (`skipBackward` 15, `skipForward` 30). */
  const val BACK: Double = 15.0
  const val FORWARD: Double = 30.0

  /** Where a skip by `delta` lands: never before the start, never past the end (a known end). */
  fun target(position: Double, by: Double, total: Double): Double {
    val p = (if (position.isFinite()) position else 0.0) + by
    if (total > 0) return min(total, max(0.0, p))
    return max(0.0, p)
  }

  /** Wall-clock seconds left to `total` at `rate`. */
  fun timeLeft(position: Double, total: Double, rate: Double): Double =
    wallClockSeconds(max(0.0, total - position), rate)

  /**
   * The two figures beside the bar, the phone's seek bar: both audio time, whatever the speed, in
   * whole seconds that add up to the length (each rounded alone, they can read a second short).
   */
  fun figures(position: Double, length: Double): Figures {
    val whole = roundHalfAway(length)
    val elapsed = min(whole, floor(if (position.isFinite()) max(0.0, position) else 0.0))
    return Figures(elapsed, whole - elapsed)
  }

  /**
   * The line under the figures: "2m left at 2×", the phone's `formatTimeLeft`. Null at normal
   * speed, where the figures already say it, and with nothing left.
   */
  fun wallClockLine(position: Double, total: Double, rate: Double): String? {
    if (PlaybackSpeed.isNormal(rate)) return null
    val time = compactDuration(timeLeft(position, total, rate)) ?: return null
    return "$time left at ${PlaybackSpeed.sentenceLabel(rate)}"
  }

  /** "12h 30m", "45m", "30s", null for nothing: the phone's `formatDuration`. */
  fun compactDuration(seconds: Double): String? {
    if (!seconds.isFinite() || seconds <= 0) return null
    val total = roundHalfAway(seconds).toInt()
    val h = total / 3600
    val m = (total % 3600) / 60
    if (h > 0) return if (m > 0) "${h}h ${m}m" else "${h}h"
    return if (m > 0) "${m}m" else "${total}s"
  }

  /** Whether a place is the book's end (within `FINISHED_TOLERANCE`). */
  fun atEnd(position: Double, total: Double): Boolean =
    total > 0 && position >= total - FINISHED_TOLERANCE
}

object ChapterNav {
  /** Previous restarts the chapter when more than this far into it (the phone's lock screen rule). */
  const val RESTART_THRESHOLD: Double = 3.0

  /**
   * Next skips a start this close ahead, so a press right after a move doesn't land on the same
   * start (the phone's `nextSegmentStart`).
   */
  const val NEXT_SLACK: Double = 1.5

  /**
   * A place this little short of a start is at it: a seek can land a hair before the start it was
   * asked for, and still reads as that chapter (the phone's 0.01).
   */
  const val AT_START: Double = 0.01

  /** The index of the chapter at `position` (the first before every chapter); null with none. */
  fun index(chapters: List<Chapter>, position: Double): Int? {
    if (chapters.isEmpty()) return null
    var current = 0
    for ((i, ch) in chapters.withIndex()) {
      if (position + AT_START >= ch.bookOffset) current = i else break
    }
    return current
  }

  /**
   * Previous chapter: this one's start when more than 3 s in, else the one before's (0 before the
   * first; the phone's `previousSegmentStart`).
   */
  fun previous(chapters: List<Chapter>, position: Double): Double? {
    if (chapters.isEmpty()) return null
    val current = chapters.lastOrNull { it.bookOffset <= position + AT_START }?.bookOffset ?: 0.0
    if (position - current > RESTART_THRESHOLD) return current
    return chapters.lastOrNull { it.bookOffset < current - AT_START }?.bookOffset ?: 0.0
  }

  /** A chapter's title, "Part 2" for one without (synthetic ones). */
  fun title(ch: Chapter, index: Int): String = if (ch.title.isBlank()) "Part ${index + 1}" else ch.title

  /** Next chapter's start: the first more than `NEXT_SLACK` ahead, null at the last one. */
  fun next(chapters: List<Chapter>, position: Double): Double? =
    chapters.firstOrNull { it.bookOffset > position + NEXT_SLACK }?.bookOffset
}

/** What Now Playing shows: the chapter's title and times within it (the whole book's without chapters). */
data class NowPlayingTimes(
  val chapterIndex: Int?,
  val title: String,
  val elapsed: Double,
  val duration: Double,
) {
  companion object {
    /**
     * The chapter at `position` and the times within it (`ChapterNav.title` names one without a
     * title), else the whole book.
     */
    fun of(chapters: List<Chapter>, position: Double, total: Double, bookTitle: String): NowPlayingTimes {
      val i =
        ChapterNav.index(chapters, position)
          ?: return NowPlayingTimes(null, bookTitle, max(0.0, position), max(0.0, total))
      val ch = chapters[i]
      // A chapter runs to the next one's start; the last to its own end, else the book's.
      val end =
        if (i + 1 < chapters.size) {
          chapters[i + 1].bookOffset
        } else if (chapterEndPosition(ch) > ch.bookOffset) {
          chapterEndPosition(ch)
        } else {
          total
        }
      val duration = max(0.0, end - ch.bookOffset)
      val into = max(0.0, position - ch.bookOffset)
      val elapsed = if (duration > 0) min(into, duration) else into
      return NowPlayingTimes(i, ChapterNav.title(ch, i), elapsed, duration)
    }
  }
}

/** This watch's own last place in a book, kept as it plays (places.json). */
@Serializable
data class LocalPlace(
  val position: Double,
  val file: String? = null,
  val filePos: Double? = null,
  val at: StoredInstant,
  /** The speed the book plays at here (a book keeps its own, as on the phone). */
  val speed: Double? = null,
) {
  companion object {
    fun of(end: SpanEnd, at: Instant, speed: Double? = null) =
      LocalPlace(end.pos, end.file, end.filePos, at, speed)
  }
}

/** Where a book starts when it is loaded, and how its first span begins. */
data class ResumePlan(
  val position: Double,
  val file: String?,
  val filePos: Double?,
  val start: ListeningStart,
  /** A finished book started again: an `unfinish` goes before its first span. */
  val unfinish: Boolean,
  /**
   * The server row was taken (resuming from it, or moving to another device's newer place): its
   * version is acknowledged.
   */
  val tookRow: Boolean,
)

object Resume {
  /**
   * Pull before play (CROSS-REPO section 25): the watch's own place unless the server holds a newer
   * one from another device at a version this watch has not seen; the server's when the watch has
   * none. A place at the end (or a finished row taken) starts again from 0 with an `unfinish` and a
   * `restart` span. A place the watch keeps over the row may still be offered (`Offers.offerOf`).
   * `waiting`: the book has events still to send (this watch's own unfinish may be among them, so
   * the server's finished row is not news).
   */
  fun plan(
    local: LocalPlace?,
    row: ProgressRow?,
    deviceId: String,
    ackVersion: Int?,
    total: Double,
    waiting: Boolean = false,
  ): ResumePlan {
    var take: ResumePlan
    if (
      row != null &&
        (shouldTake(row, local, deviceId, ackVersion) || finishWins(row, local, ackVersion, waiting))
    ) {
      take = ResumePlan(row.position, null, null, ListeningStart.RESUME, unfinish = false, tookRow = true)
      if (row.finished) return restart(tookRow = true)
    } else if (local != null) {
      take =
        ResumePlan(local.position, local.file, local.filePos, ListeningStart.RESUME, unfinish = false, tookRow = false)
      // Finished on the server, this place newer and nothing of this watch's on its way (moved back
      // into the book after its end, not played then). A listen never unfinishes, so the first span
      // goes after an `unfinish`, as a deliberate move.
      if (row?.finished == true && !waiting) {
        take = take.copy(unfinish = true, start = ListeningStart.JUMP)
      }
    } else {
      take = ResumePlan(0.0, null, null, ListeningStart.RESUME, unfinish = false, tookRow = false)
    }
    if (!take.position.isFinite() || take.position < 0) {
      take = take.copy(position = 0.0, file = null, filePos = null)
    }
    if (Skips.atEnd(take.position, total)) return restart(take.tookRow)
    return take
  }

  private fun shouldTake(row: ProgressRow, local: LocalPlace?, deviceId: String, ackVersion: Int?): Boolean {
    if (local == null) return true
    val device = row.deviceId
    if (device.isNullOrEmpty() || device == deviceId) return false
    if (row.version <= (ackVersion ?: 0)) return false
    val updated = ISOTime.parse(row.updatedAt) ?: return false
    return updated > local.at
  }

  /**
   * The phone's `serverFinishWins`: the server's finished row beats a newer place here when the
   * finish is newer than that place, or at a version this watch never acknowledged (another
   * device's finish, which the place here only did not know of). A finish is a state the server
   * orders on its own, so the book starts again rather than resuming the old place.
   */
  private fun finishWins(row: ProgressRow, local: LocalPlace?, ackVersion: Int?, waiting: Boolean): Boolean {
    if (local == null || waiting || !row.finished) return false
    val finished = row.finishedAt?.let(ISOTime::parse)
    if (finished != null && finished > local.at) return true
    return row.version > (ackVersion ?: 0)
  }

  /**
   * The speed saved for the book `plan` resumes: the row's when it was taken, else this watch's
   * own, else the row's; null for a book with none (it plays at the listener's default).
   */
  fun savedSpeed(plan: ResumePlan, local: LocalPlace?, row: ProgressRow?): Double? =
    if (plan.tookRow) row?.playbackSpeed else (local?.speed ?: row?.playbackSpeed)

  private fun restart(tookRow: Boolean) =
    ResumePlan(0.0, null, null, ListeningStart.RESTART, unfinish = true, tookRow = tookRow)
}

/** The places this watch played to, per book (`places.json`). Thread-safe. */
class PlaceStore(file: File?) {
  private val file = file?.let { JsonFile(it, SERIALIZER) }
  private var places: Map<String, LocalPlace> = this.file?.read() ?: emptyMap()

  @Synchronized fun place(ref: BookRef): LocalPlace? = places[ref.key]

  @Synchronized
  fun set(ref: BookRef, place: LocalPlace) {
    if (!place.position.isFinite()) return
    places = places + (ref.key to place)
    file?.write(places)
  }

  @Synchronized
  fun remove(ref: BookRef) {
    places = places - ref.key
    file?.write(places)
  }

  @Synchronized
  fun clear() {
    places = emptyMap()
    file?.write(null)
  }

  private companion object {
    val SERIALIZER = MapSerializer(String.serializer(), LocalPlace.serializer())
  }
}
