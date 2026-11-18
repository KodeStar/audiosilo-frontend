package expo.modules.audiosiloplayer

import androidx.media3.common.Player
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProgressTicksTest {
  @Test fun ticksWhilePlaying() {
    assertTrue(ProgressTicks.wanted(isPlaying = true, playWhenReady = true, playbackState = Player.STATE_READY))
  }

  // fe#158: a stream that buffers on its way to playing keeps the stall watchdog's heartbeat
  // going, so a dead one reaches `error` with the screen off.
  @Test fun ticksWhileBufferingToPlay() {
    assertTrue(ProgressTicks.wanted(isPlaying = false, playWhenReady = true, playbackState = Player.STATE_BUFFERING))
  }

  @Test fun quietWhenNotOnItsWayToPlaying() {
    // Paused (buffering or ready): nothing changes, nothing to tell JS.
    assertFalse(ProgressTicks.wanted(isPlaying = false, playWhenReady = false, playbackState = Player.STATE_BUFFERING))
    assertFalse(ProgressTicks.wanted(isPlaying = false, playWhenReady = false, playbackState = Player.STATE_READY))
    // A failed or stopped player (idle) and a finished book wait for no one.
    assertFalse(ProgressTicks.wanted(isPlaying = false, playWhenReady = true, playbackState = Player.STATE_IDLE))
    assertFalse(ProgressTicks.wanted(isPlaying = false, playWhenReady = true, playbackState = Player.STATE_ENDED))
  }
}
