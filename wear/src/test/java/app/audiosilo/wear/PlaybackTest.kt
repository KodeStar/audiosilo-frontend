// The playback seams that are pure enough for the JVM: wear-core's mirrored Media3 constants
// against Media3's own, and what Now Playing, Sync, Sign out and the offer say.
package app.audiosilo.wear

import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.NowPlayingTimes
import app.audiosilo.wear.core.PlaceOffer
import app.audiosilo.wear.core.PlaybackFailure
import app.audiosilo.wear.core.ProgressRow
import app.audiosilo.wear.core.SleepMode
import app.audiosilo.wear.core.SleepTimer
import app.audiosilo.wear.core.SystemPause
import app.audiosilo.wear.playback.PlayerEngine
import app.audiosilo.wear.playback.PlayerState
import app.audiosilo.wear.ui.CANT_REACH_SYNC
import app.audiosilo.wear.ui.offerTitle
import app.audiosilo.wear.ui.signOutBlocked
import app.audiosilo.wear.ui.sleepLabel
import app.audiosilo.wear.ui.syncLines
import app.audiosilo.wear.ui.timesLine
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackTest {
  @Test
  fun theCoreMirrorsMedia3sReasons() {
    assertEquals(Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST, SystemPause.PWR_USER_REQUEST)
    assertEquals(Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS, SystemPause.PWR_AUDIO_FOCUS_LOSS)
    assertEquals(Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY, SystemPause.PWR_AUDIO_BECOMING_NOISY)
    assertEquals(Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE, SystemPause.PWR_REMOTE)
    assertEquals(Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM, SystemPause.PWR_END_OF_MEDIA_ITEM)
    assertEquals(Player.PLAY_WHEN_READY_CHANGE_REASON_SUPPRESSED_TOO_LONG, SystemPause.PWR_SUPPRESSED_TOO_LONG)
    assertEquals(Player.PLAYBACK_SUPPRESSION_REASON_NONE, SystemPause.SUPPRESSION_NONE)
    assertEquals(Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS, SystemPause.SUPPRESSION_TRANSIENT_AUDIO_FOCUS_LOSS)
    assertEquals(Player.PLAYBACK_SUPPRESSION_REASON_UNSUITABLE_AUDIO_OUTPUT, SystemPause.SUPPRESSION_UNSUITABLE_AUDIO_OUTPUT)
  }

  @Test
  fun theCoreMirrorsMedia3sDamagedFileCodes() {
    assertEquals(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND, PlaybackFailure.ERROR_CODE_IO_FILE_NOT_FOUND)
    assertEquals(PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED, PlaybackFailure.ERROR_CODE_PARSING_CONTAINER_MALFORMED)
    assertEquals(PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED, PlaybackFailure.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED)
    assertEquals(PlaybackException.ERROR_CODE_DECODING_FAILED, PlaybackFailure.ERROR_CODE_DECODING_FAILED)
  }

  @Test
  fun positionsInMilliseconds() {
    assertEquals(0L, PlayerEngine.ms(-3.0))
    assertEquals(0L, PlayerEngine.ms(Double.NaN))
    assertEquals(1_500L, PlayerEngine.ms(1.5))
    assertEquals(3_600_001L, PlayerEngine.ms(3600.0005))
  }

  @Test
  fun nowPlayingFiguresAndSleep() {
    val s = PlayerState(position = 95.0, rate = 1.5, times = NowPlayingTimes(0, "One", 65.4, 600.0))
    assertEquals("1:05  -8:55", timesLine(s))
    assertEquals("", timesLine(PlayerState()))
    assertEquals("Sleep timer", sleepLabel(s))
    val armed = SleepTimer(SleepMode.Minutes(15), remaining = 600.0, stopAt = null, pausedAt = null)
    assertEquals("Sleep in 10:00", sleepLabel(s.copy(sleep = armed)))
  }

  @Test
  fun syncSaysWhereItStands() {
    val now = Instant.parse("2026-11-12T12:00:00Z")
    assertEquals(listOf("Last sync: not yet", "Waiting: 0"), syncLines(null, 0, failed = true, now))
    assertEquals(
      listOf("Last sync: 5 min ago", "Waiting: 3", CANT_REACH_SYNC),
      syncLines(Instant.parse("2026-11-12T11:55:00Z"), 3, failed = true, now),
    )
    assertEquals("1 listening update has not synced yet. Sync first, or discard to sign out.", signOutBlocked(1))
    assertEquals("2 listening updates have not synced yet. Sync first, or discard to sign out.", signOutBlocked(2))
  }

  @Test
  fun anOfferNamesTheDevice() {
    val row = ProgressRow(1, "A/B", 3725.0, 7200.0, finished = false, version = 4, updatedAt = "2026-11-12T10:00:00Z")
    assertEquals("Pixel 9 is at 1:02:05.", offerTitle(OfferPrompt(BookRef(1, "A/B"), PlaceOffer(3725.0, "Pixel 9", "d|t"), row)))
    assertEquals("Another device is at 1:02:05.", offerTitle(OfferPrompt(BookRef(1, "A/B"), PlaceOffer(3725.0, "", "d|t"), row)))
  }
}
