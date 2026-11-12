// The watch's sleep timer, a port of targets/watch/Core/SleepTimer.swift (the phone's
// `sleep-timer.ts` rules cut down: no shake, no fade, no auto sleep): a duration timer counts down
// listening time only (frozen while paused, re-armed at full length after a pause past 20 minutes,
// ended after one past 2 hours), and an end of chapter timer stops at the next chapter end at least
// 30 s of wall clock ahead (else at the end of the book; with no book left, a 15 minute timer).
package app.audiosilo.wear.core

import java.time.Instant
import kotlin.math.max

sealed interface SleepMode {
  data class Minutes(val minutes: Int) : SleepMode

  data object EndOfChapter : SleepMode
}

data class SleepTimer(
  /** How it was armed (a re-arm goes back to it). */
  val mode: SleepMode,
  /** Duration timer: wall seconds of listening left. */
  val remaining: Double,
  /** End of chapter timer: the whole-book position it stops at. */
  val stopAt: Double?,
  /** When playback paused with the timer frozen. */
  val pausedAt: Instant?,
) {
  /** `wall` seconds were listened to (only playing time counts down). */
  fun played(wall: Double): SleepTimer {
    if (stopAt != null || !wall.isFinite() || wall <= 0) return this
    return copy(remaining = max(0.0, remaining - wall))
  }

  /** Whether the timer has run out at `position`. */
  fun due(position: Double): Boolean {
    if (stopAt != null) return position >= stopAt - 0.5
    return remaining <= 0
  }

  /** Wall seconds left at `position` and `rate` (what the button shows). */
  fun left(position: Double, rate: Double): Double {
    if (stopAt != null) return max(0.0, wallClockSeconds(stopAt - position, rate))
    return remaining
  }

  fun paused(at: Instant): SleepTimer = if (pausedAt == null) copy(pausedAt = at) else this

  /**
   * Playing again at `now`: the same timer, the duration timer re-armed after a long pause, or
   * null (ended) after an abandoned one.
   */
  fun resumed(now: Instant): SleepTimer? {
    val t = copy(pausedAt = null)
    val since = pausedAt?.let { now.secondsSince(it) }
    if (since == null || stopAt != null || mode !is SleepMode.Minutes) return t
    if (since > ABANDON_AFTER_PAUSE) return null
    if (since > RESET_AFTER_PAUSE) return t.copy(remaining = mode.minutes * 60.0)
    return t
  }

  companion object {
    const val RESET_AFTER_PAUSE: Double = 20.0 * 60
    const val ABANDON_AFTER_PAUSE: Double = 2.0 * 3600

    /** A chapter end nearer than this (wall clock) is not worth arming. */
    const val MIN_CHAPTER_SECONDS: Double = 30.0
    const val FALLBACK_MINUTES: Int = 15

    /** The choices on the watch. */
    val CHOICES: List<SleepMode> =
      listOf(
        SleepMode.Minutes(15),
        SleepMode.Minutes(30),
        SleepMode.Minutes(45),
        SleepMode.Minutes(60),
        SleepMode.EndOfChapter,
      )

    /** Arm `mode` at `position`. */
    fun arm(mode: SleepMode, position: Double, rate: Double, chapters: List<Chapter>, total: Double): SleepTimer =
      when (mode) {
        is SleepMode.Minutes -> SleepTimer(mode, max(1, mode.minutes) * 60.0, null, null)
        SleepMode.EndOfChapter -> {
          val next = nextChapterEnd(chapters, position, rate, MIN_CHAPTER_SECONDS)
          if (next != null) {
            SleepTimer(mode, 0.0, next.endPosition, null)
          } else if (total > 0 && wallClockSeconds(total - position, rate) > MIN_CHAPTER_SECONDS) {
            SleepTimer(mode, 0.0, total, null)
          } else {
            SleepTimer(SleepMode.Minutes(FALLBACK_MINUTES), FALLBACK_MINUTES * 60.0, null, null)
          }
        }
      }
  }
}
