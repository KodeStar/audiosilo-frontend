// One WorkManager worker per book (decision 8): prepare, poll and download in the background, so
// a book sent from the phone starts preparing without the watch app open. Unique work per book
// (`book:<name>`, KEEP), any network as the constraint (the send itself is the test), WorkManager's
// backoff after a run that could not finish. The run itself is wear-core's BookDownload.
//
// Q3: the worker asks for unmetered Wi-Fi and binds its client to it; after 30 s with none, the
// book's row says "Waiting for Wi-Fi" and offers "Use the phone's connection (slow)", which
// re-enqueues this book on the default network (`slow`, kept on the record). The worker may lose
// its process during the wait (seen on Wear OS 6): every run is idempotent.
package app.audiosilo.wear.net

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.R
import app.audiosilo.wear.core.AddressPicker
import app.audiosilo.wear.core.BookDownload
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.DownloadRecord
import app.audiosilo.wear.core.ServerIdProbe
import app.audiosilo.wear.core.orNull
import app.audiosilo.wear.storage.Files
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class BookWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    val libraryId = inputData.getInt(KEY_LIBRARY, -1)
    val path = inputData.getString(KEY_PATH) ?: return Result.success()
    val ref = BookRef(libraryId, path)
    val model = AppModel.get(applicationContext)
    val record = model.downloads.record(ref) ?: return Result.success()
    val account = model.account.value ?: return Result.success()
    val token = model.token() ?: return Result.retry()
    showForeground(record)

    val wifi = if (record.slow) null else WifiRequest(applicationContext)
    try {
      var http = ApiClient.shared
      if (wifi != null) {
        var network = wifi.await(WifiRequest.OFFER_SLOW_AFTER_MS)
        if (network == null) {
          model.downloads.update(ref) { it.copy(waitingForWifi = true, message = BookDownload.WAITING_FOR_WIFI) }
          network = wifi.await(WifiRequest.WAIT_LIMIT_MS - WifiRequest.OFFER_SLOW_AFTER_MS)
          // Still none: the backoff takes over (the row keeps offering the phone's connection).
          if (network == null) return if (model.downloads.record(ref) == null) Result.success() else Result.retry()
        }
        model.downloads.update(ref) {
          if (it.waitingForWifi) it.copy(waitingForWifi = false, message = null) else it
        }
        http = WifiRequest.bind(ApiClient.shared, network)
      }
      // This run's own pick over its own network: home only after the tokenless probe says it is
      // this server (decision 3), so a worker in the background may use home too (decision 9).
      val client = http
      val probe: ServerIdProbe = { ApiClient.probeServerId(it, client) }
      val base = AddressPicker.pick(account.serverUrl, account.addresses, account.serverId, probe)
      // Signed out or switched while it waited: this account's token goes nowhere now.
      if (model.account.value?.accountId != account.accountId) return Result.success()
      // A run can outlast the network its pick was proven on: a home pick is proven again as it ages.
      val api = ProvenBookServer(account, base, probe) { ApiClient(it, token, client) }
      val run =
        BookDownload(api, model.downloads, model.files, ref, onProgress = { rec, done, total -> updateForeground(rec, percent(rec, done, total)) })
      // The bytes are read and written with blocking calls: not on the default dispatcher's few threads.
      return when (withContext(Dispatchers.IO) { run.run() }) {
        BookDownload.Outcome.Done,
        BookDownload.Outcome.Failed,
        BookDownload.Outcome.Gone -> Result.success()
        BookDownload.Outcome.Retry -> Result.retry()
      }
    } finally {
      wifi?.close()
      // Stage moves publish themselves (AppModel's `stages`); a failed index write (`saved`) does not.
      model.publishState()
    }
  }

  override suspend fun getForegroundInfo(): ForegroundInfo {
    val path = inputData.getString(KEY_PATH) ?: ""
    return foregroundInfo(path.substringAfterLast('/'), null, path.hashCode())
  }

  /** `setForeground` (dataSync) with "Getting <title> ready"; refused from the background on some versions, which only loses the notification. */
  private suspend fun showForeground(record: DownloadRecord) {
    orNull { setForeground(foregroundInfo(record.title, null, record.ref.path.hashCode())) }
  }

  /** The percent the notification last showed (the run reports every MiB; it changes far less often). */
  @Volatile private var shownPercent: Int? = null

  /** The notification's percent as bytes land (from the run's thread: no suspending there). */
  private fun updateForeground(record: DownloadRecord, percent: Int?) {
    if (percent == shownPercent) return
    shownPercent = percent
    try {
      setForegroundAsync(foregroundInfo(record.title, percent, record.ref.path.hashCode()))
    } catch (_: Exception) {}
  }

  private fun percent(record: DownloadRecord, done: Long, total: Long?): Int? {
    val files = record.files.size
    if (files == 0 || total == null || total <= 0) return null
    val inFile = done.toDouble() / total
    return (((record.doneCount + inFile) / files) * 100).toInt().coerceIn(0, 100)
  }

  /** The channel is made once per run, not per progress update. */
  @Volatile private var channelMade = false

  private fun foregroundInfo(title: String, percent: Int?, id: Int): ForegroundInfo {
    if (!channelMade) {
      val nm = applicationContext.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, applicationContext.getString(R.string.downloads_channel), NotificationManager.IMPORTANCE_LOW)
      )
      channelMade = true
    }
    val text = applicationContext.getString(R.string.getting_ready, title)
    val n =
      NotificationCompat.Builder(applicationContext, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setContentTitle(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .apply { if (percent != null) setProgress(100, percent, false) }
        .build()
    return ForegroundInfo(id, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
  }

  companion object {
    const val TAG = "book"
    private const val CHANNEL = "downloads"
    private const val KEY_LIBRARY = "library_id"
    private const val KEY_PATH = "path"

    fun workName(ref: BookRef): String = "book:" + Files.safeName(ref.key)

    /**
     * Start (or carry on) a book's work. `restart` replaces a running one (the listener chose the
     * phone's connection, or Try again).
     */
    fun enqueue(context: Context, ref: BookRef, restart: Boolean = false) {
      val request =
        OneTimeWorkRequestBuilder<BookWorker>()
          .setInputData(workDataOf(KEY_LIBRARY to ref.libraryId, KEY_PATH to ref.path))
          .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
          .addTag(TAG)
          .build()
      WorkManager.getInstance(context)
        .enqueueUniqueWork(workName(ref), if (restart) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request)
    }

    fun cancel(context: Context, ref: BookRef) {
      WorkManager.getInstance(context).cancelUniqueWork(workName(ref))
    }

    /** The account was left: no book of it goes on. */
    fun cancelAll(context: Context) {
      WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
    }
  }
}
