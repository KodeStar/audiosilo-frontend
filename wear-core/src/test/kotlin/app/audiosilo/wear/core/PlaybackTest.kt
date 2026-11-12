// PlaybackAttemptTests.swift ported (the deadline per attempt, the failure messages), with the
// failure mapping read from Media3's error codes instead of NSError domains; plus Wear's own rules
// for a pause the system makes (W4 decision 10), the sleep and sync labels, the open span on disk
// and the sync worker's outcome.
package app.audiosilo.wear.core

import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackAttemptTest {
  @Test
  fun pauseThenResumeNearTheOldDeadlineGivesTheNewAttemptItsOwnTime() {
    val attempt = PlaybackAttempt()
    val oldTimeout = attempt.advance()
    assertTrue(attempt.timedOut(oldTimeout, settling = true, playing = true))
    attempt.advance() // Paused while the first item is still settling.
    val resumedTimeout = attempt.advance()
    assertFalse(attempt.timedOut(oldTimeout, settling = true, playing = true))
    assertFalse("a landed-status recheck from the old play is stale too", attempt.accepts(oldTimeout))
    assertTrue(attempt.timedOut(resumedTimeout, settling = true, playing = true))
  }

  @Test
  fun aRebuiltOrStoppedQueueIgnoresThePreviousDeadline() {
    val attempt = PlaybackAttempt()
    val firstQueue = attempt.advance()
    val nextQueue = attempt.advance()
    assertFalse(attempt.timedOut(firstQueue, settling = true, playing = true))
    assertTrue(attempt.timedOut(nextQueue, settling = true, playing = true))
    attempt.advance() // Stopped and unloaded.
    assertFalse(attempt.accepts(nextQueue))
  }

  @Test
  fun aLandedOrPausedQueueDoesNotTimeOut() {
    val attempt = PlaybackAttempt()
    val token = attempt.advance()
    assertFalse(attempt.timedOut(token, settling = false, playing = true))
    assertFalse(attempt.timedOut(token, settling = true, playing = false))
  }

  @Test
  fun startAndSettlingFailuresOfferRetryWithoutTellingTheListenerToDeleteTheBook() {
    for (failure in listOf(PlaybackFailure.AUDIO_START, PlaybackFailure.SETTLING)) {
      assertTrue(failure.message.contains("Play again"))
      assertFalse(failure.message.contains("Remove"))
      assertFalse(failure.message.contains("download"))
    }
    assertTrue(PlaybackFailure.DAMAGED_DOWNLOAD.message.contains("download it again"))
  }

  @Test
  fun onlyAMissingOrUnreadableFileIsADamagedDownload() {
    for (code in listOf(2005, 3001, 3003, 4003)) {
      assertEquals("$code", PlaybackFailure.DAMAGED_DOWNLOAD, PlaybackFailure.ofError(code))
    }
    // A missing file wrapped in another code (ERROR_CODE_IO_UNSPECIFIED).
    val wrapped = IOException("io", IOException("inner", FileNotFoundException("gone")))
    assertEquals(PlaybackFailure.DAMAGED_DOWNLOAD, PlaybackFailure.ofError(2000, wrapped))
    // Unspecified, audio track init, a decoder that would not start: maybe temporary.
    for (code in listOf(1000, 5001, 4001)) {
      assertEquals("$code", PlaybackFailure.AUDIO_START, PlaybackFailure.ofError(code))
    }
    assertEquals(PlaybackFailure.AUDIO_START, PlaybackFailure.ofError(1000, IOException("x")))
  }
}

class SystemPauseTest {
  @Test
  fun aPauseTheSystemMadeIsReadFromMedia3sReason() {
    assertNull("the listener's own", SystemPause.ofPlayWhenReady(SystemPause.PWR_USER_REQUEST))
    assertEquals(Halt.FOCUS_LOST, SystemPause.ofPlayWhenReady(SystemPause.PWR_AUDIO_FOCUS_LOSS))
    assertEquals(Halt.NOISY, SystemPause.ofPlayWhenReady(SystemPause.PWR_AUDIO_BECOMING_NOISY))
    assertEquals(Halt.SUPPRESSED_TOO_LONG, SystemPause.ofPlayWhenReady(SystemPause.PWR_SUPPRESSED_TOO_LONG))
    assertEquals(Halt.OTHER, SystemPause.ofPlayWhenReady(SystemPause.PWR_REMOTE))
    assertEquals(Halt.OTHER, SystemPause.ofPlayWhenReady(SystemPause.PWR_END_OF_MEDIA_ITEM))
  }

  @Test
  fun suppressionHoldsTheAudioForFocusOrTheOutput() {
    assertNull(SystemPause.ofSuppression(SystemPause.SUPPRESSION_NONE))
    assertEquals(Halt.FOCUS_TRANSIENT, SystemPause.ofSuppression(SystemPause.SUPPRESSION_TRANSIENT_AUDIO_FOCUS_LOSS))
    assertEquals(Halt.UNSUITABLE_OUTPUT, SystemPause.ofSuppression(SystemPause.SUPPRESSION_UNSUITABLE_AUDIO_OUTPUT))
    // Media3's deprecated route reason and scrubbing say nothing to the span.
    assertNull(SystemPause.ofSuppression(2))
    assertNull(SystemPause.ofSuppression(4))
  }

  @Test
  fun onlyATransientFocusLossKeepsTheWishToPlay() {
    assertTrue(SystemPause.keepsPlaying(Halt.FOCUS_TRANSIENT))
    for (h in Halt.entries - Halt.FOCUS_TRANSIENT) assertFalse("$h", SystemPause.keepsPlaying(h))
  }

  @Test
  fun theSpeakerQuestionIsAskedOnlyUntilConfirmed() {
    assertTrue(SystemPause.asksSpeaker(Halt.UNSUITABLE_OUTPUT, speakerConfirmed = false))
    assertFalse(SystemPause.asksSpeaker(Halt.UNSUITABLE_OUTPUT, speakerConfirmed = true))
    assertFalse(SystemPause.asksSpeaker(Halt.NOISY, speakerConfirmed = false))
    assertFalse(SystemPause.asksSpeaker(null, speakerConfirmed = false))
  }

  @Test
  fun onlyAGiveUpExplainsItself() {
    assertTrue(SystemPause.message(Halt.SUPPRESSED_TOO_LONG)!!.contains("Play again"))
    for (h in Halt.entries - Halt.SUPPRESSED_TOO_LONG) assertNull("$h", SystemPause.message(h))
  }
}

class PlayerLabelsTest {
  @Test
  fun sleepChoices() {
    assertEquals(
      listOf("15 minutes", "30 minutes", "45 minutes", "60 minutes", "End of chapter"),
      SleepTimer.CHOICES.map(Labels::sleepChoice),
    )
  }

  @Test
  fun agoInPlainWords() {
    val now = iso("2026-11-12T12:00:00Z")
    assertEquals("Just now", Labels.ago(iso("2026-11-12T11:59:30Z"), now))
    assertEquals("Just now", Labels.ago(iso("2026-11-12T12:00:05Z"), now))
    assertEquals("5 min ago", Labels.ago(iso("2026-11-12T11:55:00Z"), now))
    assertEquals("2 hr ago", Labels.ago(iso("2026-11-12T09:59:00Z"), now))
    assertEquals("Yesterday", Labels.ago(iso("2026-11-11T08:00:00Z"), now))
    assertEquals("3 days ago", Labels.ago(iso("2026-11-09T12:00:00Z"), now))
  }

  @Test
  fun couldntSyncReasons() {
    assertEquals("Too old to sync (over 89 days)", Labels.reason("too_old"))
    assertEquals("The book has changed on the server", Labels.reason("duration_mismatch"))
    assertEquals("The server refused it (invalid)", Labels.reason("invalid"))
  }
}

class FileSpanStoreTest {
  private fun span(id: String) =
    OpenSpan(
      libraryId = 3,
      path = "Author/Book",
      from = SpanEnd(10.0, "a.m4a", 10.0),
      to = SpanEnd(25.0, "a.m4a", 25.0),
      duration = 3600.0,
      speed = 1.25,
      startedAt = iso("2026-11-12T10:00:00Z"),
      endedAt = iso("2026-11-12T10:00:12Z"),
      start = ListeningStart.JUMP,
      baseVersion = 7,
      id = id,
    )

  @Test
  fun theOpenSpanOutlivesAKill() {
    val dir = tempDir()
    try {
      val file = File(dir, "open-span.json")
      FileSpanStore(file).save(span("A"))
      // A new process reads what the last one kept, and a recorder closes it into the outbox.
      assertEquals(span("A"), FileSpanStore(file).load())
      val emitted = ArrayList<ListeningEvent>()
      val rec = SpanRecorder(FileSpanStore(file), AckStore(null), emit = { emitted += it })
      rec.recover()
      assertEquals(listOf("A"), emitted.map { it.id })
      assertNull(FileSpanStore(file).load())
      assertFalse(file.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun anUnreadableFileIsNoSpan() {
    val dir = tempDir()
    try {
      val file = File(dir, "open-span.json")
      file.writeText("{not json")
      assertNull(FileSpanStore(file).load())
    } finally {
      dir.deleteRecursively()
    }
  }
}

class SyncWorkerOutcomeTest {
  @Test
  fun onlyNoAnswerWithEventsWaitingRetries() {
    assertEquals(SyncSchedule.Outcome.RETRY, SyncSchedule.outcome(canSync = true, unsent = 2, flushFailed = true))
    assertEquals(SyncSchedule.Outcome.DONE, SyncSchedule.outcome(canSync = true, unsent = 0, flushFailed = false))
    // Answered, with some still waiting (a later chunk next round): the backstop takes them.
    assertEquals(SyncSchedule.Outcome.DONE, SyncSchedule.outcome(canSync = true, unsent = 2, flushFailed = false))
    // Signed out or a server without Sync v2: nothing this worker can do.
    assertEquals(SyncSchedule.Outcome.DONE, SyncSchedule.outcome(canSync = false, unsent = 2, flushFailed = true))
  }
}
