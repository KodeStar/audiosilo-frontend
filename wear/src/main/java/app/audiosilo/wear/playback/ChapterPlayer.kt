// The player the media session holds (W4 decision 10): a ForwardingPlayer over the engine's
// ExoPlayer that sends every transport command from outside the app (the system's media
// controls, the ongoing activity, headphone buttons) through PlayerEngine, so each one records its
// span like a tap in Now Playing: next / previous are chapters (whole-book, across file joins),
// the skips are 15 s back and 30 s forward, a seek within a file is a move of the book's place.
package app.audiosilo.wear.playback

import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import app.audiosilo.wear.core.Skips

class ChapterPlayer(player: Player, private val engine: PlayerEngine) : ForwardingPlayer(player) {
  override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon().addAll(*ADDED).build()

  override fun isCommandAvailable(command: Int): Boolean = command in ADDED || super.isCommandAvailable(command)

  override fun play() = engine.play()

  override fun pause() = engine.pause()

  override fun setPlayWhenReady(playWhenReady: Boolean) = if (playWhenReady) engine.play() else engine.pause()

  override fun stop() = engine.pause()

  override fun seekToNext() = engine.nextChapter()

  override fun seekToNextMediaItem() = engine.nextChapter()

  override fun seekToPrevious() = engine.previousChapter()

  override fun seekToPreviousMediaItem() = engine.previousChapter()

  override fun seekForward() = engine.skip(Skips.FORWARD)

  override fun seekBack() = engine.skip(-Skips.BACK)

  override fun getSeekForwardIncrement(): Long = PlayerEngine.ms(Skips.FORWARD)

  override fun getSeekBackIncrement(): Long = PlayerEngine.ms(Skips.BACK)

  /** A seek within the file playing (a scrubber): the book's place there. */
  override fun seekTo(positionMs: Long) = seekTo(currentMediaItemIndex, positionMs)

  /**
   * Media3's play button on an ended player seeks here before `play()`: the engine's own play
   * starts a finished book again from its start (a `restart`), so that seek is not a move.
   */
  override fun seekToDefaultPosition() {
    if (playbackState != Player.STATE_ENDED) seekTo(currentMediaItemIndex, 0)
  }

  override fun seekToDefaultPosition(mediaItemIndex: Int) = seekTo(mediaItemIndex, 0)

  override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
    val b = engine.state.value.book ?: return
    if (mediaItemIndex !in b.timeline.offsets.indices) return
    engine.seek(b.timeline.bookPosition(mediaItemIndex, positionMs / 1000.0))
  }

  companion object {
    private val ADDED =
      intArrayOf(
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_FORWARD,
        Player.COMMAND_SEEK_BACK,
      )
  }
}
