// WorkManager uses its own SQLite database, independently of the listening writer.
package app.audiosilo.wear.net

import android.database.sqlite.SQLiteCantOpenDatabaseException
import android.database.sqlite.SQLiteDiskIOException
import android.database.sqlite.SQLiteException
import android.database.sqlite.SQLiteFullException
import android.util.Log
import java.io.IOException
import java.util.concurrent.Executor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

internal fun Throwable.isWorkStorageFailure(): Boolean =
  // Bounded: a cause chain can loop back on itself (initCause across two throwables).
  generateSequence(this) { it.cause }.take(MAX_CAUSES).any {
    it is SQLiteFullException || it is SQLiteDiskIOException || it is SQLiteCantOpenDatabaseException ||
      // A file error only when it names a storage errno: a broken pipe or a bug stays a crash.
      (it is IOException && it.message?.let(STORAGE_ERRNO::containsMatchIn) == true) ||
      // SQLite may auto-rollback on SQLITE_FULL, masking the original error at endTransaction.
      (it is SQLiteException && it.message?.startsWith("cannot rollback - no transaction is active") == true)
  }

private const val MAX_CAUSES = 16
private val STORAGE_ERRNO = Regex("""\b(ENOSPC|EDQUOT|EIO|EROFS)\b""")

/** Cleanup after a job and force-stop reconciliation can throw outside an Operation. */
internal fun storageAwareExecutor(delegate: Executor, failed: (Throwable) -> Unit) =
  Executor { task ->
    delegate.execute {
      try {
        task.run()
      } catch (e: Exception) {
        if (!e.isWorkStorageFailure()) throw e
        failed(e)
      }
    }
  }

/**
 * Submit work in order. A cancellation drops the work it superseded before it reached SQLite.
 * The main dispatcher owns the queue. Awaiting an Operation or a retry leaves playback running.
 */
internal class WorkRequests(
  private val scope: CoroutineScope,
  private val hasSpace: () -> Boolean,
) {
  private class Request(val name: String, val send: suspend () -> Unit)
  private val pending = ArrayDeque<Request>()
  private var draining = false

  fun submit(name: String, cancel: Boolean = false, dropPrefix: String? = null, request: suspend () -> Unit) {
    scope.launch {
      if (cancel || dropPrefix != null) {
        pending.removeAll { it.name == name || (dropPrefix != null && it.name.startsWith(dropPrefix)) }
      }
      pending.addLast(Request(name, request))
      if (draining) return@launch
      draining = true
      try {
        while (pending.isNotEmpty()) {
          val next = pending.first()
          if (tryRequest(next)) {
            if (pending.firstOrNull() === next) pending.removeFirst()
          } else {
            delay(RETRY_MS)
          }
        }
      } finally {
        draining = false
      }
    }
  }

  private suspend fun tryRequest(request: Request): Boolean {
    if (!hasSpace()) return false
    try {
      request.send()
    } catch (e: Exception) {
      currentCoroutineContext().ensureActive()
      if (e.isWorkStorageFailure()) return false
      Log.w("WorkManager", "Background work request failed", e)
    }
    return true
  }

  companion object {
    const val RETRY_MS = 30_000L
  }
}
