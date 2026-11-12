// One run of a book's download (W4 decision 8), what wear's BookWorker does inside its
// CoroutineWorker: read the item and chapters (kept for offline playback; the timeline orders the
// files), prepare the watch rendition, poll at the server's `retry_after_seconds` (15 s at least)
// for up to 30 minutes, check the free space (the rendition's bytes plus 200 MB), then fetch each
// ready file into the book's folder with Range + If-Range on the strong ETag, so a killed process
// or a reboot carries on where it stopped. The run is idempotent: run again, it skips what landed.
//
// Differs from the Apple Watch's DownloadManager: the prepare and the polls run in the background
// too (no foreground-only polling), and the bytes come in this run, not a background session.
package app.audiosilo.wear.core

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** A download's answer: 200 (the whole file) or 206 (from `from`), its ETag and its bytes. */
class Fetched(val status: Int, val etag: String?, val body: InputStream) : Closeable {
  override fun close() = body.close()
}

/** What a book's run asks of the server (wear's ApiClient; a fake in the tests). */
interface BookServer {
  suspend fun item(ref: BookRef): Book

  suspend fun chapters(ref: BookRef): ChaptersResponse

  suspend fun progress(ref: BookRef): ProgressRow?

  suspend fun prepareRenditions(ref: BookRef): RenditionsAnswer

  suspend fun renditionStatus(ref: BookRef): RenditionsAnswer

  /**
   * A file's watch rendition from byte `from` (0: all of it), with `If-Range: ifRange` when
   * resuming. Throws `APIError` for any answer but 200 or 206, `IOException` for no answer.
   */
  suspend fun download(libraryId: Int, file: String, from: Long, ifRange: String?): Fetched
}

/** Where a book's run keeps things (wear's Files). */
interface BookStorage {
  fun folder(record: DownloadRecord): File

  fun saveItem(ref: BookRef, cache: ItemCache)

  fun loadItem(ref: BookRef): ItemCache?

  /** Free space for the books, null when unknown. */
  fun freeBytes(): Long?
}

class BookDownload(
  private val server: BookServer,
  private val index: DownloadIndex,
  private val storage: BookStorage,
  private val ref: BookRef,
  private val clock: () -> Instant = Instant::now,
  private val sleep: suspend (Double) -> Unit = { kotlinx.coroutines.delay((it * 1000).toLong()) },
  /** Told as bytes land: the record and this file's bytes so far (the notification's percent). */
  private val onProgress: (DownloadRecord, Long, Long?) -> Unit = { _, _, _ -> },
) {
  /** How one run ended. */
  sealed interface Outcome {
    /** Every file is on the watch. */
    data object Done : Outcome

    /** It can't come: the record says why (Try again in On this watch starts it afresh). */
    data object Failed : Outcome

    /** Not now: no answer, or the server took too long; the worker retries with its backoff. */
    data object Retry : Outcome

    /** The record went (removed by hand, or the account left): nothing more to do. */
    data object Gone : Outcome
  }

  private val started = clock()

  suspend fun run(): Outcome {
    val r0 = index.record(ref) ?: return Outcome.Gone
    if (r0.state == WatchStateBook.State.READY) return Outcome.Done
    if (r0.files.isEmpty() || r0.state != WatchStateBook.State.DOWNLOADING) {
      index.update(ref) { it.copy(state = WatchStateBook.State.PREPARING, message = null) }
    }
    return try {
      attempt()
    } catch (e: CancellationException) {
      throw e
    } catch (e: APIError) {
      refused(e)
    } catch (_: IOException) {
      // No answer: the worker tries again (its backoff, its network constraint).
      index.update(ref) { it.copy(message = WAITING_FOR_CONNECTION) }
      if (index.record(ref) == null) Outcome.Gone else Outcome.Retry
    }
  }

  private suspend fun attempt(): Outcome {
      if ((index.record(ref) ?: return Outcome.Gone).files.isEmpty()) readItem()
      var answer = server.prepareRenditions(ref)
      if (!checkSpace(answer)) return Outcome.Failed
      while (true) {
        currentCoroutineContext().ensureActive()
        if (!answerCovers(answer)) return Outcome.Failed
        val step = RenditionPlan.step(answer)
        for (f in step.ready) {
          when (fetch(f)) {
            FileResult.LANDED -> {}
            FileResult.GONE -> return Outcome.Gone
            FileResult.FAILED -> return Outcome.Failed
          }
        }
        when (val action = step.action) {
          RenditionPlan.Action.Done -> return if (markIfDone()) Outcome.Done else Outcome.Gone
          is RenditionPlan.Action.Failed -> return fail(RenditionPlan.message(RenditionPlan.Refusal.Failed(null)))
          is RenditionPlan.Action.Poll -> {
            if (RenditionPlan.preparedTooLong(started, clock())) return waitLonger()
            sleep(RenditionPlan.workerDelay(action.after, answer))
            answer = server.renditionStatus(ref)
          }
          is RenditionPlan.Action.PrepareAgain -> {
            if (RenditionPlan.preparedTooLong(started, clock())) return waitLonger()
            sleep(RenditionPlan.workerDelay(action.after, answer))
            answer = server.prepareRenditions(ref)
          }
        }
      }
  }

  /** The item and chapters first: the timeline orders the files and lasts offline. */
  private suspend fun readItem() {
    val book = server.item(ref)
    // Kept as "no chapters", a passing failure would stay in the book's timeline for good.
    val chapters =
      try {
        server.chapters(ref)
      } catch (e: APIError) {
        if (RenditionPlan.meansNoChapters(e)) null else throw e
      }
    val serverPlace = orNull { server.progress(ref) }
    currentCoroutineContext().ensureActive()
    val cache = ItemCache(book, chapters, serverPlace)
    storage.saveItem(ref, cache)
    val timeline = cache.timeline
    index.update(ref) { rec ->
      rec.copy(
        title = book.title.ifBlank { rec.title },
        author = book.author ?: rec.author,
        files = timeline.files.mapIndexed { i, f -> DownloadedFile(f.path, "%03d.m4a".format(i)) },
      )
    }
  }

  private suspend fun refused(e: APIError): Outcome {
    val refusal = RenditionPlan.refusal(e)
    if (refusal is RenditionPlan.Refusal.Retry) {
      // Still being made, or a passing failure: this run waits, within its 30 minutes.
      index.update(ref) { it.copy(state = WatchStateBook.State.PREPARING, message = WAITING_FOR_SERVER) }
      if (index.record(ref) == null) return Outcome.Gone
      if (RenditionPlan.preparedTooLong(started, clock())) return waitLonger()
      sleep(RenditionPlan.workerDelay(refusal.after))
      return run()
    }
    return fail(RenditionPlan.message(refusal))
  }

  /** Thirty minutes went by: the worker's backoff takes over (the server keeps making it). */
  private fun waitLonger(): Outcome {
    index.update(ref) { it.copy(message = WAITING_FOR_SERVER) }
    return if (index.record(ref) == null) Outcome.Gone else Outcome.Retry
  }

  private fun fail(message: String?): Outcome {
    index.update(ref) { it.copy(state = WatchStateBook.State.FAILED, message = message, waitingForWifi = false) }
    return if (index.record(ref) == null) Outcome.Gone else Outcome.Failed
  }

  /**
   * An answer that does not hold the book's files can never finish: the book changed on the
   * server since its item was read. Try again reads the item afresh.
   */
  private fun answerCovers(answer: RenditionsAnswer): Boolean {
    val r = index.record(ref) ?: return false
    if (RenditionPlan.covers(answer, r.files.map { it.path })) return true
    index.update(ref) { it.copy(files = emptyList()) }
    fail(CHANGED_ON_SERVER)
    return false
  }

  /**
   * Refuse a book that would not leave 200 MB free. Only for what is still to come: a file landed
   * has its space, and a part file has the bytes it holds.
   */
  private fun checkSpace(answer: RenditionsAnswer): Boolean {
    val r = index.record(ref) ?: return false
    val free = storage.freeBytes() ?: return true
    val done = r.files.filter { it.done }.map { it.path }.toSet()
    val durations = storage.loadItem(ref)?.timeline?.files?.associate { it.path to it.duration } ?: emptyMap()
    val folder = storage.folder(r)
    val partial = r.files.filter { !it.done }.sumOf { File(folder, it.local + PART).length() }
    val needed = maxOf(0L, RenditionPlan.neededBytes(answer.files.filter { it.path !in done }, durations) - partial)
    if (RenditionPlan.fits(needed, free)) return true
    fail(notEnoughSpace(needed, free))
    return false
  }

  private enum class FileResult {
    LANDED,
    GONE,
    FAILED,
  }

  /** Fetch one ready file into the book's folder, resuming a part file when its ETag still holds. */
  private suspend fun fetch(file: RenditionFile): FileResult {
    val r = index.record(ref) ?: return FileResult.GONE
    val f = r.files.firstOrNull { it.path == file.path } ?: return FileResult.LANDED
    if (f.done) return FileResult.LANDED
    val folder = storage.folder(r)
    if (!folder.isDirectory && !folder.mkdirs()) return keepFailed()
    val out = File(folder, f.local)
    val part = File(folder, f.local + PART)
    val etagFile = File(folder, f.local + ETAG)
    index.update(ref) { rec ->
      rec.copy(
        state = WatchStateBook.State.DOWNLOADING,
        message = null,
        files = rec.files.map { if (it.path == file.path) it.copy(bytes = file.bytes) else it },
      )
    }
    val have = if (part.exists()) part.length() else 0L
    val etag = if (have > 0 && etagFile.exists()) etagFile.readText().takeIf { it.isNotBlank() } else null
    val from = if (etag != null) have else 0L
    val fetched =
      try {
        server.download(ref.libraryId, file.path, from, etag)
      } catch (e: APIError) {
        if (e.status != RANGE_NOT_SATISFIABLE || from == 0L) throw e
        // Nothing past what is here (a part already whole, killed before its rename, or longer
        // than the file now is): no resume can end it, so this file starts again from 0.
        part.delete()
        etagFile.delete()
        return fetch(file)
      }
    fetched.use { answer ->
      // 206 carries on from `from`; 200 is the whole file (the ETag changed, or no resume asked).
      val resumed = answer.status == 206 && from > 0
      // A whole file's old bytes go before its ETag is kept: killed between the two, the next run
      // must not resume the old bytes under the new ETag.
      if (!resumed) etagFile.delete()
      RandomAccessFile(part, "rw").use { raf ->
        if (resumed) raf.seek(from) else raf.setLength(0)
        if (answer.etag != null && isStrong(answer.etag)) etagFile.writeText(answer.etag) else etagFile.delete()
        var written = if (resumed) from else 0L
        val buf = ByteArray(64 * 1024)
        var told = written
        while (true) {
          currentCoroutineContext().ensureActive()
          val n = answer.body.read(buf)
          if (n < 0) break
          raf.write(buf, 0, n)
          written += n
          if (written - told >= PROGRESS_STEP) {
            told = written
            index.record(ref)?.let { onProgress(it, written, file.bytes) }
          }
        }
      }
    }
    val expected = file.bytes
    if (expected != null && expected > 0 && part.length() != expected) {
      // Cut short: the next run resumes from what is here.
      throw IOException("short file: ${part.length()} of $expected bytes")
    }
    out.delete()
    if (!part.renameTo(out)) return keepFailed()
    etagFile.delete()
    val size = out.length()
    index.update(ref) { rec -> rec.copy(files = rec.files.map { if (it.path == file.path) it.copy(bytes = size, done = true) else it }) }
    return if (index.record(ref) == null) FileResult.GONE else FileResult.LANDED
  }

  private fun keepFailed(): FileResult {
    fail(COULD_NOT_KEEP)
    return if (index.record(ref) == null) FileResult.GONE else FileResult.FAILED
  }

  /** True when the book is here (or was already); false when its record went. */
  private fun markIfDone(): Boolean {
    val r =
      index.update(ref) {
        if (it.files.isNotEmpty() && it.files.all { f -> f.done }) {
          it.copy(state = WatchStateBook.State.READY, message = null, waitingForWifi = false)
        } else {
          it
        }
      } ?: return false
    return r.state == WatchStateBook.State.READY
  }

  companion object {
    const val PART = ".part"
    const val ETAG = ".etag"
    private const val PROGRESS_STEP = 1L shl 20

    const val WAITING_FOR_CONNECTION = "Waiting for a connection"
    const val WAITING_FOR_SERVER = "Waiting for the server"
    const val WAITING_FOR_WIFI = "Waiting for Wi-Fi"
    const val CHANGED_ON_SERVER = "This book changed on the server. Try again."
    const val COULD_NOT_KEEP = "The watch could not keep a file of this book."

    fun notEnoughSpace(needed: Long, free: Long): String =
      "Not enough space on this watch: it needs ${Labels.bytes(needed)} and keeps " +
        "${Labels.bytes(RenditionPlan.HEADROOM_BYTES)} free; ${Labels.bytes(free)} is free."

    /** The server's answer to a `Range` that starts at or past the file's end. */
    const val RANGE_NOT_SATISFIABLE = 416

    /** If-Range needs a strong validator: a weak one (`W/"..."`) is never sent. */
    fun isStrong(etag: String): Boolean = etag.startsWith("\"") && etag.endsWith("\"") && etag.length >= 2
  }
}
