package app.audiosilo.wear

import android.app.Application
import app.audiosilo.wear.phone.PhoneLink

/**
 * Builds the one AppModel at process start, so a worker, the media service or the Data Layer
 * listener finds it ready, then starts PhoneLink (it reads what the phone left at every start).
 */
class AudioSiloApp : Application() {
  override fun onCreate() {
    super.onCreate()
    AppModel.get(this)
    PhoneLink.start(this)
  }
}
