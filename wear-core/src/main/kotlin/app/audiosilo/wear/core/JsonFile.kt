// A small JSON document on disk: read whole, written whole and atomically (a port of
// targets/watch/Core/JSONFile.swift). The watch keeps its state in its own files dir
// (wear's storage/Files.kt names the files); the tests use a temp dir.
package app.audiosilo.wear.core

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

class JsonFile<T>(val file: File, private val serializer: KSerializer<T>) {
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
      file.delete()
      return true
    }
    return try {
      file.parentFile?.mkdirs()
      val tmp = File(file.parentFile, ".${file.name}.tmp")
      tmp.writeText(FORMAT.encodeToString(serializer, value), Charsets.UTF_8)
      Files.move(
        tmp.toPath(),
        file.toPath(),
        StandardCopyOption.REPLACE_EXISTING,
        StandardCopyOption.ATOMIC_MOVE,
      )
      true
    } catch (_: Exception) {
      false
    }
  }

  companion object {
    /** The watch's own files: the wire's spelling, so a stored event is the event it sends. */
    val FORMAT: Json = Wire.json
  }
}
