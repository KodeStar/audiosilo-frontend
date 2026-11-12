// Getting a book's watch rendition onto the watch, a port of targets/watch/Core/RenditionPlan.swift
// (Track W2's routes): `POST /libraries/{id}/renditions` prepares every file, `GET` polls until each
// is `ready`, and each ready file is fetched (`/stream?path=<file>&rendition=watch&download=1`,
// Bearer auth, resumable by Range). Pure: wear's BookWorker asks what to do next.
//
// Wear differs (W4 decision 8): the prepare and the polls run in the background worker too, so it
// waits the server's `retry_after_seconds` (15 s at least) and gives up for this run after 30
// minutes (the worker then retries with WorkManager's backoff).
package app.audiosilo.wear.core

import java.time.Instant
import kotlin.math.max

object RenditionPlan {
  /** Poll this soon when the server gave no Retry-After. */
  const val DEFAULT_POLL: Double = 5.0

  /** Never poll more often than this, whatever the server says. */
  const val MIN_POLL: Double = 2.0

  /** Free space a download must leave (W3 decision 8, carried by W4 decision 3). */
  const val HEADROOM_BYTES: Long = 200L * 1_000_000

  /** About 22 MB per audio hour: the estimate for a file whose size is not known yet. */
  const val BYTES_PER_SECOND: Double = 22_000_000.0 / 3600

  /** Wear: the background worker never asks more often than this. */
  const val WORKER_MIN_POLL: Double = 15.0

  /** Wear: how long one worker run waits for the server to make a book before it backs off. */
  const val WORKER_PREPARE_LIMIT: Double = 30.0 * 60

  /** What a renditions answer asks for. */
  sealed interface Action {
    /** Every file is ready. */
    data object Done : Action

    /** Some are still being made: ask again after this long. */
    data class Poll(val after: Double) : Action

    /** A file is `missing` (the server's queue may have been full): prepare again (POST). */
    data class PrepareAgain(val after: Double) : Action

    /** A file can't be made now; tried again by the server after `retryAfter` when known. */
    data class Failed(val retryAfter: Double?) : Action
  }

  data class Step(
    /** The files ready to download now (in the answer's order). */
    val ready: List<RenditionFile>,
    val action: Action,
  )

  /**
   * The step after a renditions answer. A failed file fails the book (its rendition was refused or
   * the encode failed); the files already ready still download.
   */
  fun step(answer: RenditionsAnswer): Step {
    val ready = answer.files.filter { it.state == "ready" }
    val failed = answer.files.filter { it.state == "failed" }
    if (failed.isNotEmpty()) {
      return Step(ready, Action.Failed(failed.mapNotNull { it.retryAfterSeconds }.maxOrNull()))
    }
    if (answer.files.isEmpty() || ready.size == answer.files.size) return Step(ready, Action.Done)
    if (answer.files.any { it.state == "missing" }) return Step(ready, Action.PrepareAgain(DEFAULT_POLL))
    return Step(ready, Action.Poll(DEFAULT_POLL))
  }

  /**
   * Wear: how long the worker waits before it asks again: the longest `retry_after_seconds` a file
   * still being made carries, else `after`, never under `WORKER_MIN_POLL`.
   */
  fun workerDelay(after: Double, answer: RenditionsAnswer? = null): Double {
    val asked = answer?.files?.filter { it.state != "ready" }?.mapNotNull { it.retryAfterSeconds }?.maxOrNull()
    return max(WORKER_MIN_POLL, asked ?: after)
  }

  /** Wear: whether a worker run that began preparing at `startedAt` has waited long enough. */
  fun preparedTooLong(startedAt: Instant, now: Instant): Boolean = now.secondsSince(startedAt) >= WORKER_PREPARE_LIMIT

  /** What a refused renditions request or download asks for. */
  sealed interface Refusal {
    /**
     * Still being made (503 `rendition_pending`) or a passing failure (503 `rendition_error`,
     * 5xx): ask again after this long.
     */
    data class Retry(val after: Double) : Refusal

    /** The file can't be encoded (422 `rendition_failed`). */
    data class Failed(val retryAfter: Double?) : Refusal

    /** This server makes no renditions now (404 `rendition_unavailable`, 400 `bad_rendition`). */
    data object Unavailable : Refusal

    /** The sign-in is gone (401): sign in again from the phone. */
    data object SignedOut : Refusal

    /** The book or file is gone (404), or no access (403). */
    data object Gone : Refusal
  }

  /**
   * Whether a renditions answer holds every file the book's timeline plays (`wanted`, by path). One
   * that does not (none at all, or other files: the book changed on the server since its item was
   * read) can never finish, so it is said rather than waited on for good.
   */
  fun covers(answer: RenditionsAnswer, wanted: List<String>): Boolean {
    val have = answer.files.map { it.path }.toSet()
    return wanted.isNotEmpty() && wanted.all { it in have }
  }

  /**
   * Whether a refused `/chapters` means the book has none to give. Not a passing failure or a lost
   * sign-in: kept as "no chapters", those would stay in the book's timeline for good.
   */
  fun meansNoChapters(e: APIError): Boolean =
    when (refusal(e)) {
      is Refusal.Retry,
      Refusal.SignedOut -> false
      is Refusal.Failed,
      Refusal.Unavailable,
      Refusal.Gone -> true
    }

  /** What a book's row says after a refusal; null for `Retry`, which waits instead. */
  fun message(r: Refusal): String? =
    when (r) {
      is Refusal.Retry -> null
      is Refusal.Failed -> "A file of this book can't be made for the watch."
      Refusal.Unavailable -> "This server can't make books for the watch now."
      Refusal.SignedOut -> "Signed out. Set up the watch again from your phone."
      Refusal.Gone -> "This book is no longer on the server."
    }

  fun refusal(e: APIError): Refusal {
    val retry = max(MIN_POLL, e.retryAfter ?: DEFAULT_POLL)
    return when {
      e.status == 422 -> Refusal.Failed(e.retryAfter)
      e.status == 401 -> Refusal.SignedOut
      e.code == "rendition_unavailable" || e.code == "bad_rendition" -> Refusal.Unavailable
      e.status == 403 || e.status == 404 -> Refusal.Gone
      e.status >= 500 || e.status == 429 || e.status == 408 -> Refusal.Retry(retry)
      else -> Refusal.Failed(null)
    }
  }

  /** A download's HTTP status as an outcome: only the file's bytes are a success. */
  fun downloadSucceeded(status: Int): Boolean = status == 200 || status == 206

  /**
   * The bytes a book's rendition needs: each file's `bytes` when known, else estimated from its
   * audio duration (`durations` by path).
   */
  fun neededBytes(files: List<RenditionFile>, durations: Map<String, Double>): Long =
    files.fold(0L) { sum, f ->
      val b = f.bytes
      if (b != null && b > 0) {
        sum + b
      } else {
        val d = durations[f.path] ?: 0.0
        sum + ((if (d > 0) d else 0.0) * BYTES_PER_SECOND).toLong()
      }
    }

  /** Whether `free` bytes hold `needed` plus the headroom. */
  fun fits(needed: Long, free: Long): Boolean = free >= needed + HEADROOM_BYTES
}
