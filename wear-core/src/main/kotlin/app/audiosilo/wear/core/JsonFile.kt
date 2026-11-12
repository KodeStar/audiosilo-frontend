// A small JSON document on disk: read whole, written whole and atomically (a port of
// targets/watch/Core/JSONFile.swift). The watch keeps its state in its own files dir
// (wear's storage/Files.kt names the files); the tests use a temp dir.
//
// `durable` documents survive a power cut too: the bytes are synced to the disk before the
// rename and the folder after it, so a battery dying mid-write leaves the old file or the new
// one, never an empty one. Only what holds listening is durable (the outbox, the open span, the
// places); the rest is rebuilt from the server or the phone, so it skips the sync (CONVENTIONS.md,
// the Wear OS app).
package app.audiosilo.wear.core

import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

class JsonFile<T>(
  val file: File,
  private val serializer: KSerializer<T>,
  /** Sync each write to the disk (see the header): for a file whose loss loses listening. */
  private val durable: Boolean = false,
) {
  /** The stored value, null when there is none or it can't be read. */
  fun read(): T? =
    try {
      if (!file.isFile) null else FORMAT.decodeFromString(serializer, file.readText(Charsets.UTF_8))
    } catch (_: Exception) {
      null
    }

  /**
   * Store `value` (null removes the file). False when it could not be stored (a full disk: the
   * memory copy goes on; the next write tries again).
   */
  fun write(value: T?): Boolean {
    if (value == null) {
      // Durable: the removal reaches the disk too, or a power cut could bring back what was closed.
      if (file.delete() && durable) synced(file)
      return true
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
