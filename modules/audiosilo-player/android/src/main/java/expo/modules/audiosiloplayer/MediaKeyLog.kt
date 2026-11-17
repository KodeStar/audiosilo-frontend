package expo.modules.audiosiloplayer

import android.content.Intent
import android.util.Log
import android.view.KeyEvent
import java.security.MessageDigest

/**
 * Diagnostics for remote buttons (fe#301: Bluetooth and steering-wheel buttons that did
 * nothing): where a media key or a transport command arrives and what the player then does.
 * Off unless turned on on the device, so a release build logs nothing:
 *
 *     adb shell setprop log.tag.AudiosiloKeys DEBUG
 *     adb logcat -s AudiosiloKeys
 *
 * (`setprop log.tag.AudiosiloKeys INFO` turns it off again.)
 */
internal object MediaKeyLog {
  const val TAG = "AudiosiloKeys"

  fun enabled(): Boolean = Log.isLoggable(TAG, Log.DEBUG)

  inline fun d(message: () -> String) {
    if (enabled()) Log.d(TAG, message())
  }

  /** A car item as a log line names it: the first 4 bytes of its id's SHA-256, enough to tell
   * the lines of one book from another's. Never the id itself, which holds the connection id,
   * the library id and the book's path. */
  fun ref(id: String?): String {
    if (id == null) return "none"
    val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray())
    return digest.take(4).joinToString("") { "%02x".format(it.toInt() and 0xFF) }
  }

  /** A media button intent's key: its name, down or up, and its repeat count. */
  fun describe(intent: Intent?): String {
    @Suppress("DEPRECATION")
    val key = intent?.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return "no key"
    val action = if (key.action == KeyEvent.ACTION_DOWN) "down" else "up"
    return "${KeyEvent.keyCodeToString(key.keyCode)} $action repeat=${key.repeatCount}"
  }
}
