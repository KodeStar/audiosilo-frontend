// Ported from watch-core/Tests/WatchCoreTests/PlayerRulesTests.swift: speed, skips, chapter moves
// and Now Playing times (the phone's rate.ts, speed-model.ts and the lock screen's chapter rules),
// the resume plan (pull before play), the sleep timer (sleep-timer.ts cut down), the account rules
// and the debug pair message. Not ported: the Apple Watch's background upload (`BackgroundSync`'s
// outcome, tag and `applyBackground`): Wear's SyncWorker flushes the outbox itself (decision 9),
// whose rules are SyncScheduleTest's.
package app.audiosilo.wear.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun chapter(i: Int, offset: Double, length: Double, title: String = "") =
  Chapter(i, title.ifEmpty { "Chapter ${i + 1}" }, 0, "a.mp3", offset, offset + length, offset)

/** Three chapters of 10 minutes. */
private val chapters = listOf(chapter(0, 0.0, 600.0), chapter(1, 600.0, 600.0), chapter(2, 1200.0, 600.0))

class SpeedAndSkipTest {
  @Test
  fun clampsSpeedToTheProductRangeAndNotANumberToOne() {
    assertEquals(2.0, PlaybackSpeed.clamp(3.0), 0.0)
    assertEquals(0.5, PlaybackSpeed.clamp(0.25), 0.0)
    assertEquals(1.25, PlaybackSpeed.clamp(1.25), 0.0)
    assertEquals(1.0, PlaybackSpeed.clamp(Double.NaN), 0.0)
    assertEquals(1.0, PlaybackSpeed.clamp(0.0), 0.0)
    assertEquals(listOf(0.8, 1.0, 1.1, 1.2, 1.25, 1.3, 1.5, 2.0), PlaybackSpeed.PRESETS)
  }

  // The phone's `bookSpeed` vectors (time-left.test.ts): a book keeps its own speed, a 3x saved
  // elsewhere plays at 2x, and a book with none plays at the listener's default.
  @Test
  fun aBooksOwnSpeedElseTheDefault() {
    assertEquals(1.5, PlaybackSpeed.book(1.5, 1.2), 0.0)
    assertEquals(2.0, PlaybackSpeed.book(3.0, 1.0), 0.0)
    assertEquals(1.2, PlaybackSpeed.book(null, 1.2), 0.0)
    assertEquals(1.2, PlaybackSpeed.book(0.0, 1.2), 0.0)
    assertEquals(1.0, PlaybackSpeed.book(null, 0.0), 0.0)
    assertEquals(1.5, PlaybackSpeed.book(Double.NaN, 1.5), 0.0)
  }

  @Test
  fun labelsASpeed() {
    assertEquals("1x", PlaybackSpeed.label(1.0))
    assertEquals("2x", PlaybackSpeed.label(2.0))
    assertEquals("1.25x", PlaybackSpeed.label(1.25))
    assertEquals("0.8x", PlaybackSpeed.label(0.8))
    assertEquals("2×", PlaybackSpeed.sentenceLabel(2.0))
    assertEquals("1.25×", PlaybackSpeed.sentenceLabel(1.25))
    assertTrue(PlaybackSpeed.isNormal(1.004))
    assertFalse(PlaybackSpeed.isNormal(1.1))
  }

  @Test
  fun aSkipStaysInsideTheBook() {
    assertEquals(0.0, Skips.target(10.0, -Skips.BACK, 1800.0), 0.0)
    assertEquals(85.0, Skips.target(100.0, -Skips.BACK, 1800.0), 0.0)
    assertEquals(1800.0, Skips.target(1790.0, Skips.FORWARD, 1800.0), 0.0)
    assertEquals(130.0, Skips.target(100.0, Skips.FORWARD, 0.0), 0.0)
    assertEquals(30.0, Skips.target(Double.NaN, Skips.FORWARD, 1800.0), 0.0)
  }

  @Test
  fun timeLeftIsWallClockAtTheSpeed() {
    assertEquals(600.0, Skips.timeLeft(600.0, 1800.0, 2.0), 0.0)
    assertEquals(0.0, Skips.timeLeft(1900.0, 1800.0, 1.0), 0.0)
    assertTrue(Skips.atEnd(1796.0, 1800.0))
    assertFalse(Skips.atEnd(1790.0, 1800.0))
    assertFalse(Skips.atEnd(0.0, 0.0))
  }

  @Test
  fun theFiguresAreAudioTimeAndAddUpToTheLength() {
    // A 4-minute chapter, whatever the speed: the figures take none.
    assertEquals(Figures(0.0, 240.0), Skips.figures(0.0, 240.0))
    assertEquals(Figures(240.0, 0.0), Skips.figures(240.0, 240.0))
    assertEquals(Figures(80.0, 160.0), Skips.figures(80.0, 240.0))
    var position = 0.0
    while (position <= 240.4) {
      val f = Skips.figures(position, 240.4)
      assertEquals("at $position", 240.0, f.elapsed + f.left, 0.0)
      assertEquals(roundHalfAway(f.elapsed), f.elapsed, 0.0)
      position += 0.37
    }
  }

  @Test
  fun theFiguresStayInsideTheLength() {
    assertEquals(Figures(240.0, 0.0), Skips.figures(300.0, 240.0))
    assertEquals(Figures(0.0, 240.0), Skips.figures(-5.0, 240.0))
    assertEquals(Figures(0.0, 240.0), Skips.figures(Double.NaN, 240.0))
  }

  @Test
  fun theWallClockLineSaysTheSpeedAndIsAbsentAtNormalSpeed() {
    assertEquals("2m left at 2×", Skips.wallClockLine(0.0, 240.0, 2.0))
    assertEquals("48m left at 1.25×", Skips.wallClockLine(0.0, 3600.0, 1.25))
    assertEquals("1h 15m left at 0.8×", Skips.wallClockLine(0.0, 3600.0, 0.8))
    assertEquals("15s left at 2×", Skips.wallClockLine(210.0, 240.0, 2.0))
    assertNull(Skips.wallClockLine(0.0, 240.0, 1.0))
    assertNull("1x as it is shown", Skips.wallClockLine(0.0, 240.0, 1.004))
  }

  @Test
  fun theWallClockLineIsAbsentWithNothingLeftOrNoLength() {
    assertNull(Skips.wallClockLine(240.0, 240.0, 2.0))
    assertNull(Skips.wallClockLine(300.0, 240.0, 2.0))
    assertNull(Skips.wallClockLine(0.0, 0.0, 2.0))
  }

  @Test
  fun theCompactDurationIsThePhones() {
    // formatDuration's cases, src/lib/format.ts.
    assertEquals("12h 30m", Skips.compactDuration(45000.0))
    assertEquals("2h", Skips.compactDuration(7200.0))
    assertEquals("45m", Skips.compactDuration(2700.0))
    assertEquals("30s", Skips.compactDuration(30.0))
    assertEquals("0s", Skips.compactDuration(0.4))
    assertNull(Skips.compactDuration(0.0))
    assertNull(Skips.compactDuration(Double.NaN))
  }
}

class ChapterNavTest {
  @Test
  fun previousRestartsTheChapterPastThreeSecondsElseGoesBack() {
    assertEquals(600.0, ChapterNav.previous(chapters, 610.0))
    assertEquals(0.0, ChapterNav.previous(chapters, 602.0))
    assertEquals(0.0, ChapterNav.previous(chapters, 2.0))
    assertNull(ChapterNav.previous(emptyList(), 100.0))
  }

  @Test
  fun nextIsTheNextStartAndNothingAtTheLast() {
    assertEquals(600.0, ChapterNav.next(chapters, 0.0))
    assertEquals(1200.0, ChapterNav.next(chapters, 700.0))
    assertNull(ChapterNav.next(chapters, 1300.0))
    // A start under 1.5 s ahead is skipped (the phone's slack).
    assertEquals(1200.0, ChapterNav.next(chapters, 599.0))
  }

  // A seek lands a hair short of the start it asked for (1234.567 at timescale 600 is
  // 1234.5666...): it is that chapter, and Next goes on from it.
  @Test
  fun aSeekLandingJustShortOfAStartIsThatChapter() {
    val odd = listOf(chapter(0, 0.0, 1234.567), chapter(1, 1234.567, 1165.433), chapter(2, 2400.0, 600.0))
    val landed = 740_740.0 / 600
    assertTrue(landed < 1234.567)
    assertEquals(1, ChapterNav.index(odd, landed))
    assertEquals(1, NowPlayingTimes.of(odd, landed, 3000.0, "B").chapterIndex)
    // Next twice moves on twice.
    assertEquals(1234.567, ChapterNav.next(odd, 10.0))
    assertEquals(2400.0, ChapterNav.next(odd, landed))
    // Previous right after landing goes to the chapter before.
    assertEquals(0.0, ChapterNav.previous(odd, landed))
  }

  @Test
  fun previousBeforeTheFirstChapterGoesToTheStart() {
    val late = listOf(chapter(0, 30.0, 600.0), chapter(1, 630.0, 600.0))
    assertEquals(0.0, ChapterNav.previous(late, 10.0))
    assertEquals(0.0, ChapterNav.previous(late, 31.0))
    assertEquals(30.0, ChapterNav.previous(late, 40.0))
  }

  @Test
  fun nowPlayingShowsTheChaptersTitleAndTimesWithinIt() {
    assertEquals(
      NowPlayingTimes(1, "Chapter 2", 150.0, 600.0),
      NowPlayingTimes.of(chapters, 750.0, 1800.0, "Book"),
    )
  }

  @Test
  fun nowPlayingRunsTheLastChapterToTheBooksEndWithoutAnEnd() {
    val open = listOf(chapter(0, 0.0, 600.0), Chapter(1, " ", 0, "a.mp3", 600.0, 0.0, 600.0))
    assertEquals(NowPlayingTimes(1, "Part 2", 400.0, 1200.0), NowPlayingTimes.of(open, 1000.0, 1800.0, "Book"))
  }

  @Test
  fun nowPlayingWithoutChaptersIsTheWholeBook() {
    assertEquals(
      NowPlayingTimes(null, "Book", 90.0, 1800.0),
      NowPlayingTimes.of(emptyList(), 90.0, 1800.0, "Book"),
    )
  }
}

class ResumeTest {
  private val at = iso("2026-10-25T08:00:00.000Z")

  private fun row(
    position: Double = 900.0,
    finished: Boolean = false,
    version: Int = 5,
    device: String? = "phone",
    updatedAt: String = "2026-10-25T09:00:00.000Z",
    finishedAt: String? = null,
    speed: Double? = 1.0,
  ) =
    ProgressRow(
      libraryId = 3,
      path = "Author/Book",
      position = position,
      duration = 1800.0,
      finished = finished,
      playbackSpeed = speed,
      version = version,
      deviceId = device,
      updatedAt = updatedAt,
      finishedAt = finishedAt,
    )

  private fun plan(
    position: Double,
    file: String? = null,
    filePos: Double? = null,
    start: ListeningStart = ListeningStart.RESUME,
    unfinish: Boolean = false,
    tookRow: Boolean = false,
  ) = ResumePlan(position, file, filePos, start, unfinish, tookRow)

  @Test
  fun withNoPlaceHereTheServersRowIsTakenAndAcked() {
    assertEquals(plan(900.0, tookRow = true), Resume.plan(null, row(), "watch", null, 1800.0))
  }

  @Test
  fun theWatchsOwnPlaceStandsOverItsOwnRow() {
    val local = LocalPlace(300.0, "a.mp3", 300.0, at)
    assertEquals(
      plan(300.0, "a.mp3", 300.0),
      Resume.plan(local, row(device = "watch"), "watch", 2, 1800.0),
    )
  }

  @Test
  fun anotherDevicesNewerPlaceAtAnUnseenVersionIsTaken() {
    val local = LocalPlace(300.0, at = at)
    val p = Resume.plan(local, row(), "watch", 4, 1800.0)
    assertEquals(900.0, p.position, 0.0)
    assertTrue(p.tookRow)
  }

  @Test
  fun aSeenVersionOrAnOlderRowLeavesThePlaceHere() {
    val local = LocalPlace(300.0, at = at)
    assertEquals(300.0, Resume.plan(local, row(version = 4), "watch", 4, 1800.0).position, 0.0)
    val older = Resume.plan(local, row(updatedAt = "2026-10-25T07:00:00.000Z"), "watch", 1, 1800.0)
    assertEquals(300.0, older.position, 0.0)
    assertFalse(older.tookRow)
  }

  @Test
  fun offlineTheWatchsPlaceElseTheStart() {
    val local = LocalPlace(300.0, at = at)
    assertEquals(300.0, Resume.plan(local, null, "watch", null, 1800.0).position, 0.0)
    assertEquals(plan(0.0), Resume.plan(null, null, "watch", null, 1800.0))
  }

  @Test
  fun aFinishedBookOrAPlaceAtTheEndStartsAgainWithUnfinishAndRestart() {
    val finished = Resume.plan(null, row(position = 1800.0, finished = true), "watch", null, 1800.0)
    assertEquals(plan(0.0, start = ListeningStart.RESTART, unfinish = true, tookRow = true), finished)
    val local = LocalPlace(1798.0, at = at)
    val end = Resume.plan(local, null, "watch", null, 1800.0)
    assertEquals(ListeningStart.RESTART, end.start)
    assertEquals(0.0, end.position, 0.0)
  }

  // The phone's `serverFinishWins`.
  @Test
  fun aFinishNewerThanThePlaceHereStartsTheBookAgain() {
    val local = LocalPlace(300.0, at = at)
    val r = row(position = 1800.0, finished = true, version = 5, device = "watch", finishedAt = "2026-10-25T08:30:00Z")
    assertEquals(
      plan(0.0, start = ListeningStart.RESTART, unfinish = true, tookRow = true),
      Resume.plan(local, r, "watch", 5, 1800.0),
    )
  }

  @Test
  fun aFinishAtAVersionNotSeenHereStartsTheBookAgain() {
    val local = LocalPlace(300.0, at = at)
    val r =
      row(
        position = 1800.0,
        finished = true,
        version = 6,
        updatedAt = "2026-10-25T07:00:00.000Z",
        finishedAt = "2026-10-25T07:00:00Z",
      )
    assertEquals(
      plan(0.0, start = ListeningStart.RESTART, unfinish = true, tookRow = true),
      Resume.plan(local, r, "watch", 5, 1800.0),
    )
  }

  @Test
  fun aFinishedRowWithThisWatchsEventsWaitingLeavesThePlaceHere() {
    val local = LocalPlace(300.0, "a.mp3", 300.0, at)
    val r = row(position = 1800.0, finished = true, version = 6, device = "watch", finishedAt = "2026-10-25T08:30:00Z")
    assertEquals(plan(300.0, "a.mp3", 300.0), Resume.plan(local, r, "watch", 5, 1800.0, waiting = true))
  }

  // Moved back into a book after its end and never played then: a listen never unfinishes, so the
  // first span goes after an `unfinish`.
  @Test
  fun aPlaceNewerThanASeenFinishUnfinishesFirst() {
    val local = LocalPlace(300.0, "a.mp3", 300.0, at)
    val r =
      row(
        position = 1800.0,
        finished = true,
        version = 5,
        device = "watch",
        updatedAt = "2026-10-25T07:00:00.000Z",
        finishedAt = "2026-10-25T07:00:00Z",
      )
    assertEquals(
      plan(300.0, "a.mp3", 300.0, ListeningStart.JUMP, unfinish = true),
      Resume.plan(local, r, "watch", 5, 1800.0),
    )
  }

  @Test
  fun theSpeedFollowsThePlaceTaken() {
    val r = row(speed = 1.5)
    val local = LocalPlace(300.0, at = at, speed = 1.2)
    val took = plan(900.0, tookRow = true)
    val kept = plan(300.0)
    assertEquals(1.5, Resume.savedSpeed(took, local, r))
    assertEquals(1.2, Resume.savedSpeed(kept, local, r))
    val noSpeedHere = LocalPlace(300.0, at = at)
    assertEquals(1.5, Resume.savedSpeed(kept, noSpeedHere, r))
    assertNull(Resume.savedSpeed(kept, null, null))
  }

  @Test
  fun aPlaceKeepsItsSpeedAcrossAWrite() {
    val place = LocalPlace.of(SpanEnd(12.0, "a.mp3", 12.0), at, 1.3)
    val text = JsonFile.FORMAT.encodeToString(LocalPlace.serializer(), place)
    assertEquals(1.3, JsonFile.FORMAT.decodeFromString(LocalPlace.serializer(), text).speed)
    val older = """{"position":12,"at":"1970-01-01T00:00:00Z"}"""
    assertNull(JsonFile.FORMAT.decodeFromString(LocalPlace.serializer(), older).speed)
  }

  @Test
  fun aPlaceThatIsNotANumberIsTheStart() {
    val local = LocalPlace(Double.NaN, "a.mp3", Double.NaN, at)
    val p = Resume.plan(local, null, "watch", null, 1800.0)
    assertEquals(0.0, p.position, 0.0)
    assertNull(p.file)
  }

  @Test
  fun thePlaceStoreKeepsANumberAndPersists() {
    val dir = tempDir()
    try {
      val file = java.io.File(dir, "places.json")
      val ref = BookRef(3, "Author/Book")
      val store = PlaceStore(file)
      store.set(ref, LocalPlace(42.0, at = at))
      store.set(ref, LocalPlace(Double.NaN, at = at))
      assertEquals(42.0, PlaceStore(file).place(ref)?.position)
      store.clear()
      assertNull(PlaceStore(file).place(ref))
    } finally {
      dir.deleteRecursively()
    }
  }
}

class SleepTimerTest {
  private val t0 = iso("2026-10-25T22:00:00.000Z")

  @Test
  fun aDurationTimerCountsDownListeningOnly() {
    var t = SleepTimer.arm(SleepMode.Minutes(15), 0.0, 1.0, chapters, 1800.0)
    assertEquals(900.0, t.left(0.0, 1.0), 0.0)
    t = t.played(600.0)
    assertFalse(t.due(600.0))
    t = t.played(-5.0)
    t = t.played(Double.NaN)
    assertEquals(300.0, t.remaining, 0.0)
    t = t.played(400.0)
    assertTrue(t.due(1000.0))
    assertEquals(0.0, t.remaining, 0.0)
  }

  @Test
  fun endOfChapterStopsAtTheNextEndAtLeast30sAway() {
    val t = SleepTimer.arm(SleepMode.EndOfChapter, 100.0, 1.0, chapters, 1800.0)
    assertEquals(600.0, t.stopAt)
    assertEquals(150.0, t.left(300.0, 2.0), 0.0)
    assertFalse(t.due(599.0))
    assertTrue(t.due(599.6))
    // 20 s from a chapter end: the next one.
    assertEquals(1200.0, SleepTimer.arm(SleepMode.EndOfChapter, 580.0, 1.0, chapters, 1800.0).stopAt)
  }

  @Test
  fun endOfChapterWithNoChapterEndLeftAimsAtTheBooksEndElseFifteenMinutes() {
    assertEquals(1800.0, SleepTimer.arm(SleepMode.EndOfChapter, 100.0, 1.0, emptyList(), 1800.0).stopAt)
    val fallback = SleepTimer.arm(SleepMode.EndOfChapter, 1790.0, 1.0, chapters, 1800.0)
    assertNull(fallback.stopAt)
    assertEquals(SleepMode.Minutes(15), fallback.mode)
    assertEquals(900.0, fallback.remaining, 0.0)
  }

  @Test
  fun aShortPauseKeepsTheCountdownALongOneReArmsItAnAbandonedOneEndsIt() {
    var t = SleepTimer.arm(SleepMode.Minutes(30), 0.0, 1.0, emptyList(), 1800.0)
    t = t.played(1200.0)
    t = t.paused(t0)
    assertEquals(600.0, t.resumed(t0.addingSeconds(5.0 * 60))?.remaining)
    assertEquals(1800.0, t.resumed(t0.addingSeconds(25.0 * 60))?.remaining)
    assertNull(t.resumed(t0.addingSeconds(3.0 * 3600)))
    assertNull(t.resumed(t0.addingSeconds(60.0))?.pausedAt)
  }

  @Test
  fun aChapterTimerOutlivesAPause() {
    val t = SleepTimer.arm(SleepMode.EndOfChapter, 100.0, 1.0, chapters, 1800.0).paused(t0)
    assertEquals(600.0, t.resumed(t0.addingSeconds(5.0 * 3600))?.stopAt)
  }
}

class AccountRulesTest {
  @Test
  fun aPairForAnotherAccountIsBlockedWhileEventsWaitUnlessDiscarded() {
    assertEquals(AccountChange.SignIn, AccountRules.change(null, "s.1", 3))
    assertEquals(AccountChange.SameAccount, AccountRules.change("s.1", "s.1", 3))
    assertEquals(AccountChange.Blocked(3), AccountRules.change("s.1", "s.2", 3))
    assertEquals(AccountChange.Replace, AccountRules.change("s.1", "s.2", 3, discard = true))
    assertEquals(AccountChange.Replace, AccountRules.change("s.1", "t.1", 0))
  }

  @Test
  fun signingOutIsBlockedWhileEventsWaitUnlessDiscarded() {
    assertEquals(SignOutGate.Blocked(2), AccountRules.signOut(2, discard = false))
    assertEquals(SignOutGate.Allowed, AccountRules.signOut(2, discard = true))
    assertEquals(SignOutGate.Allowed, AccountRules.signOut(0, discard = false))
  }
}

class DebugPairTest {
  @Test
  fun aPairMessageReadsFromJSONText() {
    val json =
      """
      {"v":1,"type":"pair","server_id":"srv","server_name":"Home","user_id":2,"user_name":"kode",
       "base_url":"http://192.168.1.5:8080","server_url":"http://192.168.1.5:8080","addresses":{},
       "pairing_token":"tok","expires_at":"2026-11-04T12:00:00Z","phone_name":"Simulator"}
      """
    val p = PhoneMessages.decodeJSON(json) as PhoneMessage.Pair
    assertEquals("srv.2", p.message.accountId)
    assertEquals("http://192.168.1.5:8080", p.message.baseUrl)
    assertNull(PhoneMessages.decodeJSON("{"))
    assertNull(PhoneMessages.decodeJSON("""{"v":2,"type":"pair"}"""))
  }
}
