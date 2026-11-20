package app.audiosilo.wear

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.work.Configuration
import androidx.work.Operation
import androidx.work.WorkManager
import app.audiosilo.wear.net.WorkRequests
import app.audiosilo.wear.net.isWorkStorageFailure
import app.audiosilo.wear.net.storageAwareExecutor
import app.audiosilo.wear.phone.PhoneLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.launch

/**
 * Builds the one AppModel at process start, so a worker, the media service or the Data Layer
 * listener finds it ready, then starts PhoneLink (it reads what the phone left at every start).
 */
class AudioSiloApp : Application(), Configuration.Provider {
  private val workScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val requests = WorkRequests(workScope) { noBackupFilesDir.usableSpace > 0 }

  override val workManagerConfiguration: Configuration by lazy {
    Configuration.Builder()
      .setTaskExecutor(storageAwareExecutor(Dispatchers.IO.asExecutor(), ::workStorageFailed))
      .setInitializationExceptionHandler(::workStorageFailed)
      .build()
  }

  private fun workStorageFailed(e: Throwable) {
    if (!e.isWorkStorageFailure()) throw e
    Log.w("WorkManager", "Watch storage unavailable for background work", e)
    workScope.launch { AppModel.get(this@AudioSiloApp).retrySyncAfterStorageFailure() }
  }

  override fun onCreate() {
    super.onCreate()
    AppModel.get(this)
    PhoneLink.start(this)
  }

  companion object {
    internal fun submitWork(
      context: Context,
      name: String,
      cancel: Boolean = false,
      dropPrefix: String? = null,
      request: (WorkManager) -> Operation,
    ) {
      val app = context.applicationContext as AudioSiloApp
      app.requests.submit(name, cancel, dropPrefix) { request(WorkManager.getInstance(app)).result.await() }
    }
  }
}
