// Who this watch is to the server (decision 11): `device_id`, a UUID made once and kept in
// noBackupFilesDir (a restore never gives two watches one id), and `device_name` for the
// exchange (Settings.Global.DEVICE_NAME, else the model; the docs do not promise the watch's
// own name).
package app.audiosilo.wear.storage

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.io.File
import java.util.UUID

object DeviceIdentity {
  /** This watch's `device_id`, made once and kept in `file`. */
  @Synchronized
  fun deviceId(file: File): String {
    val kept =
      try {
        file.readText().trim()
      } catch (_: Exception) {
        ""
      }
    if (kept.isNotEmpty()) return kept
    val id = UUID.randomUUID().toString().uppercase()
    try {
      file.parentFile?.mkdirs()
      file.writeText(id)
    } catch (_: Exception) {}
    return id
  }

  fun deviceName(context: Context): String {
    val name =
      try {
        Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
      } catch (_: Exception) {
        null
      }
    return name?.takeIf { it.isNotBlank() } ?: Build.MODEL ?: "Wear OS watch"
  }
}
