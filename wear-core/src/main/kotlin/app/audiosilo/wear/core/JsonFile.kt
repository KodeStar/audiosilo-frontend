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
// they were asked (fe#285).
package app.audiosilo.wear.core

import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
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
 * caller's memory copy goes on at once. Writes that fail are dropped, as the caller's ignored them.
 */
class DurableWriter(executor: Executor? = null) {
  @Volatile private var thread: Thread? = null
  private val executor: Executor =
    executor
      ?: Executors.newSingleThreadExecutor { r ->
        Thread(r, "audiosilo-durable-writes").also {
          it.isDaemon = true
          thread = it
        }
      }

  /** Run `op` after everything asked before it; returns at once. */
  fun submit(op: () -> Unit) {
    executor.execute {
      try {
        op()
      } catch (_: Exception) {
        // A write that failed: the next one of that file tries again, as on the caller's thread.
      }
    }
  }

  /** Run `op` after everything asked before it, and wait for its answer. */
  fun <R> now(op: () -> R): R {
    if (Thread.currentThread() === thread) return op()
    val task = FutureTask(op)
    executor.execute(task)
    return try {
      task.get()
    } catch (e: java.util.concurrent.ExecutionException) {
      throw e.cause ?: e
    }
  }

  /** Wait until everything asked so far is on the disk (signing out: nothing of it lands later). */
  fun drain() = now {}
}

class JsonFile<T>(
  val file: File,
  private val serializer: KSerializer<T>,
  /** Sync each write to the disk (see the header): for a file whose loss loses listening. */
  private val durable: Boolean = false,
  /** Where a durable document's writes run (null: on the caller's thread). */
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

  /**
   * Store `value` (null removes the file). False when it could not be stored (a full disk: the
   * memory copy goes on; the next write tries again). With a `writer` it is queued there and true
   * means asked, not done (`writeNow` waits for the answer).
   */
  fun write(value: T?): Boolean {
    val w = writer ?: return store(value)
    w.submit { store(value) }
    return true
  }

  /** `write`, waiting for its turn on the `writer` (after every write asked before it) and its answer. */
  fun writeNow(value: T?): Boolean = writer?.now { store(value) } ?: store(value)

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
