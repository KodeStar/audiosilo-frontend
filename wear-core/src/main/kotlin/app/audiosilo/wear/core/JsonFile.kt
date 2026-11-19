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
 * A write that fails (a full disk) stays first in the queue and is tried again, with a doubling
 * wait capped at `MAX_RETRY_DELAY_MS` (`retryDelayMs`), until it lands, before anything asked
 * after it runs: a later write landing first would leave a state the in-order writes never pass
 * through (a place without the span it came from, a span's removal without its event), and a
 * kill there loses listening. A write asked meanwhile never tries it again sooner. While it
 * fails, a write asked behind it takes the place of one of the same file still waiting (the
 * latest content, at the later place), so the queue holds one write per file however long the
 * disk stays full; the files then catch up in the order of their last writes (those few writes
 * mix two states the in-order writes passed through, the price of a bounded queue; a kill while
 * the disk is full finds the state before the failing write). Nothing waits on it: `now` behind
 * it is told `Stuck`, and `attempt` false. Nothing else is dropped but by `forget` (signing out).
 */
class DurableWriter(
  executor: Executor? = null,
  /** Runs a retry after the given ms (the tests' seam; null: the writer's own thread, or `executor` at once). */
  retryAfter: ((Long, Runnable) -> Unit)? = null,
) {
  /** `now` could not run its op: a write asked before it fails (it is tried again meanwhile). */
  class Stuck : java.io.IOException("an earlier write fails")

  private sealed interface Entry

  /**
   * `key`: the file it writes (coalescing, `forget`), null for none. `tried`: told whether its
   * first try landed (`attempt`), false at once when a write before it fails.
   */
  private class Write(val key: Any?, val op: () -> Boolean, val tried: CompletableFuture<Boolean>? = null) : Entry

  private class Call<R>(val op: () -> R) : Entry {
    val answer = CompletableFuture<R>()

    /** Run `op` into `answer` (a value or a throw, for its caller). */
    fun run() {
      try {
        answer.complete(op())
      } catch (e: Exception) {
        answer.completeExceptionally(e)
      }
    }
  }

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

  /** The head's failed tries since a write last landed (0: the head has not failed). */
  private var failures = 0

  /** The retry of the head waiting for its delay (its own, so one a `forget` outran is spent), else null. */
  private var retry: Any? = null

  /** The head failed its last try: it is being tried again, or waits to be. */
  private val failing
    get() = failures > 0

  /** The head is being run (off the lock). */
  private var running = false

  /** The head being run is one `forget` dropped: gone once this try ends, landed or not. */
  private var runningForgotten = false

  /** Runs of `pump` asked of the executor and not begun. */
  private var pumps = 0

  /** The entries waiting (the tests' bound). */
  internal val queued: Int
    get() = synchronized(lock) { queue.size }

  /**
   * Run `op` after everything asked before it has landed; returns at once. `op` answers whether
   * it landed; `key` names the file it writes (coalescing, `forget`).
   */
  fun submit(key: Any? = null, op: () -> Boolean) = enqueue(Write(key, op))

  /**
   * `submit`, waiting for its first try only: true once it landed. False when that try failed, or
   * a write before it fails (it waits its turn there): either way it stays queued and is tried
   * again in the background, so the caller never waits out a disk with no room. Never on the
   * writer's own thread.
   */
  fun attempt(key: Any? = null, op: () -> Boolean): Boolean {
    check(Thread.currentThread() !== thread) { "attempt on the writer's own thread" }
    val tried = CompletableFuture<Boolean>()
    enqueue(Write(key, op, tried))
    return tried.get()
  }

  /**
   * Run `op` after everything asked before it has landed, and wait for its answer. Throws `Stuck`
   * (`op` not run) as soon as a write asked before it fails, rather than wait for it to land.
   */
  fun <R> now(op: () -> R): R {
    if (Thread.currentThread() === thread) return op()
    val call = Call(op)
    enqueue(call)
    return try {
      call.answer.get()
    } catch (e: java.util.concurrent.ExecutionException) {
      throw e.cause ?: e
    }
  }

  /** `now`, answering `stuck` instead of throwing `Stuck`. */
  fun <R> nowOr(stuck: R, op: () -> R): R =
    try {
      now(op)
    } catch (_: Stuck) {
      stuck
    }

  /** Wait until everything asked so far is on the disk; false at once when a write fails (`Stuck`). */
  fun drain(): Boolean = nowOr(false) { true }

  /**
   * Drop every write of `keys` not begun (signing out: the account's files, whose removals are
   * asked next), and the retry one of them waits for, so a write a full disk still refuses neither
   * holds those removals back nor makes the sign-out wait out its tries. One being run now is
   * gone once that try ends. The other files' writes keep their place and order.
   */
  fun forget(keys: Collection<Any>) {
    synchronized(lock) {
      val head = queue.firstOrNull()
      val dropped = ArrayList<Write>()
      queue.removeAll { e ->
        if (e !is Write || e.key == null || e.key !in keys) return@removeAll false
        if (running && e === head) {
          runningForgotten = true
          return@removeAll false
        }
        dropped += e
        true
      }
      if (runningForgotten || queue.firstOrNull() !== head) {
        // A new head (or one once this try ends): tried at once, its own count (a retry still
        // waiting is spent), and a drain behind the removals waits for them.
        failures = 0
        retry = null
      }
      for (w in dropped) w.tried?.complete(false)
      wakeIfIdle()
    }
  }

  private fun enqueue(entry: Entry) {
    synchronized(lock) {
      if (failing) {
        when (entry) {
          // Told now: the write before it may not land for a long while.
          is Call<*> -> entry.answer.completeExceptionally(Stuck())
          is Write -> {
            coalesce(entry)
            entry.tried?.complete(false)
          }
        }
        return
      }
      queue.addLast(entry)
      wakeIfIdle()
    }
  }

  /**
   * Queue `write` behind a failing head (the lock held), in place of the writes of its file still
   * waiting there: the latest content wins, so the queue stays one write per file.
   */
  private fun coalesce(write: Write) {
    if (write.key != null) {
      val head = queue.removeFirst()
      queue.removeAll { it is Write && it.key == write.key }
      queue.addFirst(head)
    }
    queue.addLast(write)
  }

  /**
   * Ask the executor for a run of `pump` (the lock held) when the queue has an entry and nothing
   * else will run it: no run asked, none running (it asks for the next when done), no retry
   * waiting.
   */
  private fun wakeIfIdle() {
    if (queue.isEmpty() || pumps > 0 || running || retry != null) return
    pumps++
    executor.execute(::pump)
  }

  /** Run the head of the queue once, if no retry's delay holds it. */
  private fun pump() {
    val head =
      synchronized(lock) {
        pumps--
        if (running || retry != null) return
        queue.firstOrNull()?.also { running = true } ?: return
      }
    val landed = run(head)
    synchronized(lock) {
      running = false
      val forgotten = runningForgotten
      runningForgotten = false
      // Still first: `forget` keeps the head it finds running (dropped here).
      if (landed || forgotten) {
        queue.removeFirst()
        failures = 0
      } else {
        failures++
        retryLater()
        // Nobody waits behind it: the disk may have no room for a long while.
        val calls = queue.filterIsInstance<Call<*>>()
        queue.removeAll { it is Call<*> }
        for (c in calls) c.answer.completeExceptionally(Stuck())
        for (e in queue) if (e !== head) (e as? Write)?.tried?.complete(false)
      }
      // Told after the retry is asked, so a caller woken by it finds that one waiting.
      (head as? Write)?.tried?.complete(landed)
      // The next entry's run (one run of `pump` at a time).
      wakeIfIdle()
    }
  }

  /** Try the failed head again after `retryDelayMs` (the lock held). */
  private fun retryLater() {
    val mine = Any()
    retry = mine
    retryAfter(retryDelayMs(failures)) {
      val due =
        synchronized(lock) {
          (retry === mine).also {
            if (it) {
              retry = null
              pumps++
            }
          }
        }
      if (due) pump()
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
      is Call<*> -> {
        entry.run()
        true
      }
    }

  companion object {
    /** The longest wait between a failed write's tries. */
    const val MAX_RETRY_DELAY_MS = 30_000L

    /** The wait before a failed write's next try: 0.5 s, doubling, at most `MAX_RETRY_DELAY_MS`. */
    fun retryDelayMs(failures: Int): Long = (500L shl (failures - 1).coerceIn(0, 6)).coerceAtMost(MAX_RETRY_DELAY_MS)
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
  /** This document's name on the `writer` (coalescing, `DurableWriter.forget`). */
  private val key = writerKey(file)

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
   * (`DurableWriter`), and `writeNow` waits for its first try.
   */
  fun write(value: T?): Boolean {
    val w = writer ?: return store(value)
    w.submit(key) { store(value) }
    return true
  }

  /**
   * `write`, waiting for its first try on the `writer` (after every write asked before it): true
   * once it landed. False when that try failed or a write before it fails: it stays queued there
   * and is tried again in the background (`DurableWriter.attempt`).
   */
  fun writeNow(value: T?): Boolean {
    val w = writer ?: return store(value)
    return w.attempt(key) { store(value) }
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

    /** The name a document of `file` has on its `DurableWriter` (`DurableWriter.forget`). */
    fun writerKey(file: File): Any = file.absoluteFile

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
