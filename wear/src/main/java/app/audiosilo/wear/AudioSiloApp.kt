package app.audiosilo.wear

import android.app.Application

/** Builds the one AppModel at process start, so a worker or the listener finds it ready. */
class AudioSiloApp : Application() {
  override fun onCreate() {
    super.onCreate()
    AppModel.get(this)
  }
}
