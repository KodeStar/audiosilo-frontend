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
}
