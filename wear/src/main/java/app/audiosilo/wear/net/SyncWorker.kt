// Background sync (W4 decision 9), the twin of the Apple Watch's background upload and refresh
// task: WorkManager runs this worker, unique work `sync`, on any network (the send itself is the
// connectivity test), expedited when a span closes with events unsent or the app goes to the
// background with events unsent, plus a 15 minute periodic backstop (`sync-periodic`) while events
// wait, cancelled once nothing does. Each run flushes the app's own outbox, so every attempt builds
// its body then, with a fresh `sent_at` (the phone's rule); it picks its own address, running the
// tokenless `server_id` probe first, so the home address is allowed here too.
package app.audiosilo.wear.net

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkerParameters
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.AudioSiloApp
import app.audiosilo.wear.R
import app.audiosilo.wear.core.SyncSchedule
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    val model = withContext(Dispatchers.Main) { AppModel.get(applicationContext) }
    val outcome =
      try {
        withContext(Dispatchers.Main) { model.syncInBackground() }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Throwable) {
        // A run that throws fails, and so does every run appended after it (APPEND_OR_REPLACE):
        // none of them starts, so the gate must not wait on one (fe#285).
        withContext(Dispatchers.Main) { model.syncRunFailed() }
        throw e
      }
    return when (outcome) {
      SyncSchedule.Outcome.DONE -> Result.success()
      SyncSchedule.Outcome.RETRY -> Result.retry()
    }
  }

  /** Expedited work before Android 12 runs as a foreground service: a quiet notification for it. */
  override suspend fun getForegroundInfo(): ForegroundInfo {
    val nm = applicationContext.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL, applicationContext.getString(R.string.sync_channel), NotificationManager.IMPORTANCE_MIN)
    )
    val n =
      NotificationCompat.Builder(applicationContext, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentTitle(applicationContext.getString(R.string.syncing))
        .setOngoing(true)
        .build()
    return ForegroundInfo(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
  }

  companion object {
    private const val CHANNEL = "sync"
    private const val NOTIFICATION_ID = 0x5c

    private val connected = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /**
     * Send what waits from the background now, after any run already going (`APPEND_OR_REPLACE`:
     * KEEP dropped this while a run was past its last look at the outbox, fe#285). Asked once per
     * run (`ExpediteGate`): a run still waiting to start sends everything when it does.
     */
    fun expedite(context: Context) {
      AudioSiloApp.submitWork(context, SyncSchedule.UNIQUE_WORK) { wm ->
        // Enqueue can commit before scheduling fails. A retry must append a new work ID.
        val request =
          OneTimeWorkRequestBuilder<SyncWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(connected)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        wm.enqueueUniqueWork(SyncSchedule.UNIQUE_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
      }
    }

    /** The 15 minute backstop while events wait (on), or not (off). */
    fun backstop(context: Context, on: Boolean) {
      if (!on) {
        cancel(context, SyncSchedule.PERIODIC_WORK)
        return
      }
      AudioSiloApp.submitWork(context, SyncSchedule.PERIODIC_WORK) { wm ->
        val request =
          PeriodicWorkRequestBuilder<SyncWorker>(SyncSchedule.PERIODIC_MINUTES, TimeUnit.MINUTES).setConstraints(connected).build()
        wm.enqueueUniquePeriodicWork(SyncSchedule.PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
      }
    }

    /** Signed out: nothing of the account is sent any more. */
    fun cancelAll(context: Context) {
      cancel(context, SyncSchedule.UNIQUE_WORK)
      cancel(context, SyncSchedule.PERIODIC_WORK)
    }

    private fun cancel(context: Context, name: String) =
      AudioSiloApp.submitWork(context, name, cancel = true) { it.cancelUniqueWork(name) }
  }
}
