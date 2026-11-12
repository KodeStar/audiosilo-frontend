// What the screens say for numbers and states, the port of the `Labels` in
// targets/watch/UI/Screens.swift that the rules' messages use too.
package app.audiosilo.wear.core

import java.util.Locale
import kotlin.math.abs

object Labels {
  /** A book's state on its row. */
  fun state(s: WatchStateBook.State): String =
    when (s) {
      WatchStateBook.State.QUEUED -> "Waiting to download"
      WatchStateBook.State.PREPARING -> "Preparing on the server"
      WatchStateBook.State.DOWNLOADING -> "Downloading"
      WatchStateBook.State.READY -> "On this watch"
      WatchStateBook.State.FAILED -> "Couldn't download"
    }

  /** "1 listening update has", "2 listening updates have". */
  fun updates(n: Int): String = if (n == 1) "1 listening update has" else "$n listening updates have"

  /**
   * Bytes in decimal units, as the Apple Watch's `ByteCountFormatter` (`.file`) writes them:
   * "512 bytes", "12 KB", "3.4 MB", "1.2 GB" (one decimal from MB up, under 100).
   */
  fun bytes(n: Long): String {
    val units = listOf("bytes", "KB", "MB", "GB", "TB")
    var value = n.toDouble()
    var unit = 0
    while (abs(value) >= 1000 && unit < units.size - 1) {
      value /= 1000
      unit++
    }
    return when {
      unit == 0 -> if (n == 1L) "1 byte" else "$n bytes"
      unit == 1 || abs(value) >= 100 -> "${Math.round(value)} ${units[unit]}"
      else -> {
        val s = String.format(Locale.ROOT, "%.1f", value).removeSuffix(".0")
        "$s ${units[unit]}"
      }
    }
  }

  /** Seconds as "1:02:03" or "2:03". */
  fun clock(seconds: Double): String {
    val s = if (seconds.isFinite() && seconds > 0) seconds.toLong() else 0L
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec) else String.format(Locale.ROOT, "%d:%02d", m, sec)
  }

  /** A sleep timer choice. */
  fun sleepChoice(mode: SleepMode): String =
    when (mode) {
      is SleepMode.Minutes -> "${mode.minutes} minutes"
      SleepMode.EndOfChapter -> "End of chapter"
    }

  /** How long ago `at` was, from `now`: "Just now", "5 min ago", "2 hr ago", "3 days ago". */
  fun ago(at: java.time.Instant, now: java.time.Instant): String {
    val s = now.epochSecond - at.epochSecond
    return when {
      s < 60 -> "Just now"
      s < 3600 -> "${s / 60} min ago"
      s < 86_400 -> "${s / 3600} hr ago"
      s < 2 * 86_400 -> "Yesterday"
      else -> "${s / 86_400} days ago"
    }
  }

  /** A couldn't-sync reason in plain words. */
  fun reason(r: String): String =
    when (r) {
      "too_old" -> "Too old to sync (over 89 days)"
      "too_large" -> "Too large to send"
      "no_access" -> "The book is no longer yours to sync"
      "not_found" -> "The book is no longer on the server"
      "duration_mismatch" -> "The book has changed on the server"
      else -> "The server refused it ($r)"
    }
}
