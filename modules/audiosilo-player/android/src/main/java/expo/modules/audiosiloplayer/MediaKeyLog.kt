package expo.modules.audiosiloplayer

import android.content.Intent
import android.util.Log
import android.view.KeyEvent

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

  /** A media button intent's key: its name, down or up, and its repeat count. */
  fun describe(intent: Intent?): String {
    @Suppress("DEPRECATION")
    val key = intent?.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return "no key"
    val action = if (key.action == KeyEvent.ACTION_DOWN) "down" else "up"
    return "${KeyEvent.keyCodeToString(key.keyCode)} $action repeat=${key.repeatCount}"
  }
}
