// A small JSON document on disk: read whole, written whole and atomically (a port of
// targets/watch/Core/JSONFile.swift). The watch keeps its state in its own files dir
// (wear's storage/Files.kt names the files); the tests use a temp dir.
//
// `durable` documents survive a power cut too: the bytes are synced to the disk before the
// rename and the folder after it, so a battery dying mid-write leaves the old file or the new
// one, never an empty one. Only what holds listening is durable (the outbox, the open span and the
// move recovered from one, the places); the rest is rebuilt from the server or the phone, so it
// skips the sync (CONVENTIONS.md, the Wear OS app). Given a `DurableWriter`, a durable document's
// writes leave the caller's thread (the main looper) for the writer's one thread, in the order
// they were asked, a failed one tried again before any after it (fe#285).
package app.audiosilo.wear.core

import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

/** What `JsonFile.load` found (Core/JSONFile.swift's `JSONLoad`). */
sealed interface JsonLoad<out T> {
  data object Missing : JsonLoad<Nothing>

  data class Value<T>(val value: T) : JsonLoad<T>

  /** There, but it can't be read. */
  data object Unreadable : JsonLoad<Nothing>

  /** It reads but does not decode (damaged, or another build's format). */
  data object Corrupt : JsonLoad<Nothing>
}

/**
 * The durable files' writes off the caller's thread (fe#285): one thread runs them one at a time,
 * in the order they were asked, across every file it is given. That order is what the listening
 * relies on (an event kept before its span leaves its file, a place before the span's removal):
 * a kill stops the writes at some point, and every point of that one sequence is a state the
 * writes on the caller's thread passed through too. The values handed in are immutable, so the
 * caller's memory copy goes on at once.
 *
 * A write that fails (a full disk) stays first in the queue and is tried again, `MAX_TRIES` times
 * in all with a doubling wait (`retryDelayMs`), before anything asked after it runs: a later write
 * landing first would leave a state the in-order writes never pass through (a place without the
 * span it came from, a span's removal without its event), and a kill there loses listening. Once
 * its tries are spent the queue waits, the write still first, until the next write is asked, which
 * starts a new round of tries (the disk may have room by then). Nothing is dropped but by
 * `dropSuperseded` (signing out).
 */
class DurableWriter(
  executor: Executor? = null,
  /** Runs a retry after the given ms (the tests' seam; null: the writer's own thread, or `executor` at once). */
  retryAfter: ((Long, Runnable) -> Unit)? = null,
) {
  /** `now` could not run its op: a write asked before it still fails after its round of tries. */
  class Stuck : java.io.IOException("an earlier write still fails")

  private sealed interface Entry

  /** `key`: the file it writes (`dropSuperseded`), null for none. */
  private class Write(val key: Any?, val op: () -> Boolean) : Entry

  private class Call(val op: () -> Any?, val answer: CompletableFuture<Any?>) : Entry

  @Volatile private var thread: Thread? = null
  private val executor: Executor
  private val retryAfter: (Long, Runnable) -> Unit

  init {
    if (executor != null) {
      this.executor = executor
      this.retryAfter = retryAfter ?: { _, r -> executor.execute(r) }
    } else {
      val own =
        Executors.newSingleThreadScheduledExecutor { r ->
          Thread(r, "audiosilo-durable-writes").also {
            it.isDaemon = true
            thread = it
          }
        }
      this.executor = own
      this.retryAfter = retryAfter ?: { ms, r -> own.schedule(r, ms, TimeUnit.MILLISECONDS) }
    }
  }

  private val lock = Any()
  private val queue = ArrayDeque<Entry>()

  /** The head's failed tries this round. */
  private var failures = 0

  /** A retry of the head is waiting for its delay. */
  private var retrying = false

  /** The head's tries are spent: nothing runs until another write is asked. */
  private var parked = false

  /** The head is being run (off the lock). */
  private var running = false

  /** Runs of `pump` asked of the executor and not begun. */
  private var pumps = 0

  /**
   * Run `op` after everything asked before it has landed; returns at once. `op` answers whether
   * it landed; `key` names the file it writes (`dropSuperseded`).
   */
  fun submit(key: Any? = null, op: () -> Boolean) = enqueue(Write(key, op))

  /**
   * Run `op` after everything asked before it has landed, and wait for its answer. Throws `Stuck`
   * (`op` not run) when a write asked before it still fails once its round of tries is spent.
   */
  fun <R> now(op: () -> R): R {
    if (Thread.currentThread() === thread) return op()
    val answer = CompletableFuture<Any?>()
    enqueue(Call(op, answer))
    return try {
      @Suppress("UNCHECKED_CAST")
      answer.get() as R
    } catch (e: java.util.concurrent.ExecutionException) {
      throw e.cause ?: e
    }
  }

  /** Wait until everything asked so far is on the disk; false when a write still fails (`Stuck`). */
  fun drain(): Boolean =
    try {
      now {}
      true
    } catch (_: Stuck) {
      false
    }

  /**
   * Drop each write not begun that a later write of the same file replaces (signing out, whose
   * removals replace every listening file: a write of them that still fails must not hold those
   * back). The states between are skipped, so only for a caller that needs the end state alone.
   */
  fun dropSuperseded() {
    synchronized(lock) {
      val head = queue.firstOrNull()
      val later = HashSet<Any>()
      val kept = ArrayList<Entry>()
      for (e in queue.reversed()) {
        val key = (e as? Write)?.key
        if (key != null && !later.add(key) && !(running && e === head)) continue
        kept += e
      }
      kept.reverse()
      queue.clear()
      queue.addAll(kept)
      if (queue.firstOrNull() !== head) {
        // A new head: a round of its own, at once (a retry still waiting finds it there).
        failures = 0
        retrying = false
        parked = false
      }
      if (queue.isNotEmpty() && pumps == 0 && !running) wake()
    }
  }

  private fun enqueue(entry: Entry) {
    synchronized(lock) {
      queue.addLast(entry)
      // A new round of tries for a write whose last round was spent.
      if (parked) {
        parked = false
        failures = 0
      }
      wake()
    }
  }

  /** Ask the executor for a run of `pump` (the lock held). */
  private fun wake() {
    pumps++
    executor.execute(::pump)
  }

  /** Run the head of the queue once, if nothing holds it (a retry's delay, a spent round). */
  private fun pump() {
    val head =
      synchronized(lock) {
        pumps--
        if (running || retrying || parked) return
        queue.firstOrNull()?.also { running = true } ?: return
      }
    val landed = run(head)
    synchronized(lock) {
      running = false
      // Still first: `dropSuperseded` keeps the head it finds running.
      if (queue.firstOrNull() === head) {
        if (landed) {
          queue.removeFirst()
          failures = 0
        } else {
          failures++
          if (failures < MAX_TRIES) {
            retrying = true
            retryAfter(retryDelayMs(failures)) {
              synchronized(lock) {
                retrying = false
                pumps++
              }
              pump()
            }
          } else {
            parked = true
            // A `now` behind it would wait for a disk that may never have room: told instead.
            val calls = queue.filterIsInstance<Call>()
            queue.removeAll { it is Call }
            for (c in calls) c.answer.completeExceptionally(Stuck())
          }
        }
      }
      // Every entry has a run of `pump` coming: the runs asked for the entries behind a retry
      // were spent while it waited.
      if (queue.isNotEmpty() && pumps == 0 && !retrying && !parked) wake()
    }
  }

  /** Whether `entry` is done: a write that landed, or a call (its answer, a value or a throw, is its caller's). */
  private fun run(entry: Entry): Boolean =
    when (entry) {
      is Write ->
        try {
          entry.op()
        } catch (_: Exception) {
          false
        }
      is Call -> {
        try {
          entry.answer.complete(entry.op())
        } catch (e: Exception) {
          entry.answer.completeExceptionally(e)
        }
        true
      }
    }

  companion object {
    /** A failed write's tries in one round (the first and its retries). */
    const val MAX_TRIES = 6

    /** The wait before a failed write's next try: 0.5 s, doubling, at most 8 s. */
    fun retryDelayMs(failures: Int): Long = 500L shl (failures - 1).coerceIn(0, 4)
  }
}

class JsonFile<T>(
  val file: File,
  private val serializer: KSerializer<T>,
  /** Sync each write to the disk (see the header): for a file whose loss loses listening. */
  private val durable: Boolean = false,
  /**
   * Where this document's writes run, in order with every other document given it (null: on the
   * caller's thread): the durable ones, and the few whose order against them matters.
   */
  private val writer: DurableWriter? = null,
) {
  /** The stored value, null when there is none or it can't be read (`load` tells them apart). */
  fun read(): T? = (load() as? JsonLoad.Value)?.value

  /** What is stored: none, a value, a file that can't be read, or one that does not decode. */
  fun load(): JsonLoad<T> {
    if (!file.exists()) return JsonLoad.Missing
    val text =
      try {
        file.readText(Charsets.UTF_8)
      } catch (_: Exception) {
        return JsonLoad.Unreadable
      }
    return try {
      JsonLoad.Value(FORMAT.decodeFromString(serializer, text))
    } catch (_: Exception) {
      JsonLoad.Corrupt
    }
  }

  /**
   * Move the file aside, beside it as `<prefix><uuid>.json`, so the next write never goes over it.
   * False when it could not be moved.
   */
  fun moveAside(prefix: String): Boolean = file.renameTo(File(file.absoluteFile.parentFile, prefix + UUID.randomUUID() + ".json"))

  /**
   * `moveAside` for a file that must not be written over: true once it is out of the way (moved,
   * or gone meanwhile), false while it is still there, when nothing may be written in its place.
   */
  fun setAside(prefix: String): Boolean = moveAside(prefix) || !file.exists()

  /** The files `moveAside(prefix)` left beside this one. */
  fun asides(prefix: String): List<File> =
    file.absoluteFile.parentFile?.listFiles { f -> f.name.startsWith(prefix) }?.toList() ?: emptyList()

  /**
   * Store `value` (null removes the file). False when it could not be stored (a full disk: the
   * memory copy goes on; the next write tries again). With a `writer` it is queued there and true
   * means asked, not done: a write that fails there is tried again before any asked after it
   * (`DurableWriter`), and `writeNow` waits for the answer.
   */
  fun write(value: T?): Boolean {
    val w = writer ?: return store(value)
    w.submit(file.absoluteFile) { store(value) }
    return true
  }

  /**
   * `write`, waiting for its turn on the `writer` (after every write asked before it) and its
   * answer. False, nothing written, when a write before it still fails (`DurableWriter.Stuck`).
   */
  fun writeNow(value: T?): Boolean {
    val w = writer ?: return store(value)
    return try {
      w.now { store(value) }
    } catch (_: DurableWriter.Stuck) {
      false
    }
  }

  private fun store(value: T?): Boolean {
    if (value == null) {
      // Durable: the removal reaches the disk too, or a power cut could bring back what was closed.
      val removed = file.delete()
      if (removed && durable) synced(file)
      // False when it is still there (the outbox's join keeps what it would have dropped).
      return removed || !file.exists()
    }
    return try {
      atomicWrite(file, FORMAT.encodeToString(serializer, value).toByteArray(Charsets.UTF_8), durable)
      true
    } catch (_: Exception) {
      false
    }
  }

  companion object {
    /** The watch's own files: the wire's spelling, so a stored event is the event it sends. */
    val FORMAT: Json = Wire.json

    /** Told of each durable write's (or removal's) file once it is synced (the tests' seam). */
    @Volatile internal var onSynced: ((File) -> Unit)? = null

    /**
     * Write `bytes` beside `file` and move them in, so a reader sees the old file or the new one,
     * never half of either, and a write that fails leaves what was there. `durable` also syncs
     * the bytes before the move and the folder after it (a power cut). Throws when it can't.
     */
    fun atomicWrite(file: File, bytes: ByteArray, durable: Boolean = false) {
      val dir = file.absoluteFile.parentFile
      dir?.mkdirs()
      val tmp = File(dir, ".${file.name}.tmp")
      try {
        FileOutputStream(tmp).use { out ->
          out.write(bytes)
          if (durable) out.fd.sync()
        }
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
      } catch (e: Exception) {
        tmp.delete()
        throw e
      }
      if (durable) synced(file)
    }

    /** Sync `file`'s folder (its rename or removal), then tell the tests' seam. */
    private fun synced(file: File) {
      file.absoluteFile.parentFile?.let(::syncFolder)
      onSynced?.invoke(file)
    }

    /**
     * Sync a folder's entries (the rename). Linux and Android open a folder for reading; a JVM
     * that can't (Windows) skips it, as the file's own bytes are already on the disk.
     */
    private fun syncFolder(dir: File) {
      try {
        FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
      } catch (_: Exception) {
        // Best effort: see above.
      }
    }
  }
}
