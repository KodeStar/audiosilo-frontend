// The one activity: the screens, the life cycle the model follows (front and back), the
// notification permission (asked once, after sign-in: the download and playback notifications),
// and in debug builds the sign-in from intent extras (DebugSignIn, compiled out of release).
package app.audiosilo.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import app.audiosilo.wear.debug.DebugSignIn
import app.audiosilo.wear.phone.PhoneLink
import app.audiosilo.wear.ui.WearApp
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  private val model by lazy { AppModel.get(this) }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { WearApp(model) }
    if (savedInstanceState == null) DebugSignIn.handle(model, intent)
    lifecycleScope.launch {
      model.phase.first { it == AppModel.Phase.Ready }
      askForNotificationsOnce()
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    DebugSignIn.handle(model, intent)
  }

  override fun onStart() {
    super.onStart()
    model.becameActive()
    PhoneLink.onForeground(this)
  }

  override fun onStop() {
    model.wentToBackground()
    super.onStop()
  }

  private fun askForNotificationsOnce() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    if (prefs.getBoolean(ASKED, false)) return
    prefs.edit().putBoolean(ASKED, true).apply()
    // The answer needs no handling: without it the downloads and playback still run, unannounced.
    ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
  }

  private companion object {
    const val PREFS = "app"
    const val ASKED = "askedNotifications"
  }
}
