// Release builds take no sign-in from intent extras: the debug one lives in src/debug. This empty
// stand-in keeps MainActivity's call compiling; R8 removes it.
package app.audiosilo.wear.debug

import android.content.Intent
import app.audiosilo.wear.AppModel

object DebugSignIn {
  @Suppress("UNUSED_PARAMETER")
  fun handle(model: AppModel, intent: Intent?) = Unit
}
