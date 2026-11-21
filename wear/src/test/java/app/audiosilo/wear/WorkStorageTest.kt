package app.audiosilo.wear

import android.database.sqlite.SQLiteDiskIOException
import android.database.sqlite.SQLiteException
import android.database.sqlite.SQLiteFullException
import androidx.work.Configuration
import app.audiosilo.wear.net.WorkRequests
import app.audiosilo.wear.net.isWorkStorageFailure
import app.audiosilo.wear.net.storageAwareExecutor
import java.io.IOException
import java.util.concurrent.CompletionException
import java.util.concurrent.Executor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkStorageTest {
  @Test
  fun launchInstallsStorageHandlersForWorkManager() {
    assertTrue(
      "WorkManager must use the watch's configuration at first use",
      Configuration.Provider::class.java.isAssignableFrom(AudioSiloApp::class.java),
    )
    Dispatchers.setMain(StandardTestDispatcher())
    try {
      assertNotNull(AudioSiloApp().workManagerConfiguration.initializationExceptionHandler)
    } finally {
      Dispatchers.resetMain()
    }
  }

  @Test
  fun cleanupAndForceStopRollbackDoNotEscapeTheTaskExecutor() {
    val rollback = object : SQLiteException() {
      override val message = "cannot rollback - no transaction is active (code 1 SQLITE_ERROR)"
    }
    val failures = mutableListOf<Throwable>()
    val executor = storageAwareExecutor(Executor(Runnable::run)) { failures += it }
    val init = IllegalStateException("Database inaccessible", SQLiteFullException())
    for (failure in listOf(rollback, init)) executor.execute { throw failure }
    assertEquals(listOf(rollback, init), failures)
    assertFalse(SQLiteException().isWorkStorageFailure())
    assertTrue(IllegalStateException(IOException("write failed: ENOSPC (No space left on device)")).isWorkStorageFailure())
    assertFalse("not a storage failure", IllegalStateException(IOException("Broken pipe")).isWorkStorageFailure())
    val looped = RuntimeException()
    looped.initCause(RuntimeException(looped))
    assertFalse("a cause cycle ends", looped.isWorkStorageFailure())
    assertThrows(IllegalArgumentException::class.java) { executor.execute { throw IllegalArgumentException("invalid work") } }
  }

  @Test
  fun fullDiskDefersInitializationAndRetriesFailedOperationsWithoutAnotherTrigger() = runTest {
    var hasSpace = false
    val work = WorkRequests(this) { hasSpace }
    var attempts = 0
    work.submit("sync") {
      attempts++
      when (attempts) {
        1 -> throw SQLiteFullException()
        2 -> throw CompletionException(SQLiteDiskIOException())
      }
    }
    runCurrent()
    assertEquals("a full volume must not open WorkManager", 0, attempts)
    hasSpace = true
    advanceTimeBy(3 * WorkRequests.RETRY_MS)
    runCurrent()
    assertEquals(3, attempts)
  }

  @Test
  fun signOutDropsDeferredBooksAndSyncBeforeTheNextAccountEnqueues() = runTest {
    var hasSpace = false
    val work = WorkRequests(this) { hasSpace }
    val ran = mutableListOf<String>()
    work.submit("book:a") { ran += "old book" }
    work.submit("sync") { ran += "old sync" }
    runCurrent()
    work.submit("book", dropPrefix = "book:") { ran += "cancel books" }
    work.submit("sync", cancel = true) { ran += "cancel sync" }
    work.submit("book:a") { ran += "new book" }
    work.submit("sync") { ran += "new sync" }
    runCurrent()
    hasSpace = true
    advanceTimeBy(WorkRequests.RETRY_MS)
    runCurrent()
    assertEquals(listOf("cancel books", "cancel sync", "new book", "new sync"), ran)
  }

}
