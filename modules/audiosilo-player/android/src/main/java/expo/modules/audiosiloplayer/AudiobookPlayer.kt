package expo.modules.audiosiloplayer

import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player

/** What [AudiobookPlayer] asks of its service (the session knows who sent a command). */
interface AudiobookPlayerHooks {
  /** True when the Player call in progress came from a controller other than the app's own
   * (`MediaSession.getControllerForCurrentRequest`, see [AudiosiloPlayerService]). */
  fun isRemoteRequest(): Boolean

  /** A remote seek/skip/chapter jump just landed (the player's position is already the new one). */
  fun onRemoteMove()

  /** A remote controller changed the speed; [rate] is already applied. */
  fun onRemoteRate(rate: Float)
}

/**
 * Wraps the ExoPlayer so audiobook behavior applies no matter where a command
 * originates (lock screen, notification, headset, Android Auto or the JS bridge - all route
 * through the session's player):
 *  - **Auto-rewind on resume** lives in [play] (not the JS bridge), so resuming from the
 *    lock screen rewinds too. [prepare] and every new queue reset the baseline so a freshly
 *    loaded book never inherits the previous one's pause time.
 *  - **Prev/next** are exposed only when there's more than one item (chapter clips or a
 *    multi-file book) -> the lock screen gets prev/next-chapter buttons. With a single
 *    item (a chapterless single-file book) they're hidden so a tap can't "restart the
 *    only book".
 *  - **Configurable skips**: [seekBack]/[seekForward] seek by the live [PlayerConfig]
 *    intervals instead of ExoPlayer's build-time increments, so the lock-screen skip
 *    buttons (and any other controller) honor the Settings value.
 *  - **Remote moves** (Phase 6): every seek entry point reports, once it landed, a move that a
 *    controller OTHER than the app asked for ([AudiobookPlayerHooks.onRemoteMove]), so JS can
 *    lower its resume floor for a lock-screen scrub. Not reported: the app's own seeks, the
 *    auto-rewind inside [play] ([internal]), Smart Speed's silence skips and a file/clip
 *    advancing at its end (neither calls a seek method on this wrapper).
 *  - **Remote speed**: a controller other than the app changing the speed is reported too.
 */
class AudiobookPlayer(player: Player, private val hooks: AudiobookPlayerHooks) : ForwardingPlayer(player) {
  private var pausedAt: Long = 0L

  /** Nesting depth of seek calls (seekForward calls seekTo): only the outermost reports. */
  private var moveDepth = 0

  /** >0 while the service or this wrapper moves the player on its own behalf. */
  private var internalDepth = 0

  /** Overrides the session's origin for commands the session does not attribute (custom
   * session commands run in `onCustomCommand`, where `getControllerForCurrentRequest` is null). */
  private var forcedRemote: Boolean? = null

  /**
   * Set by the service just before it completes a car play request with the queue the app's
   * JS already loaded: Media3 then sets that same queue again, which would rebuild the
   * playlist and rebuffer from scratch. The next identical set is skipped instead.
   */
  var absorbIdenticalSet = false

  override fun getAvailableCommands(): Player.Commands {
    val base = super.getAvailableCommands()
    if (mediaItemCount > 1) return base
    return base.buildUpon()
      .removeAll(
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
      )
      .build()
  }

  override fun prepare() {
    pausedAt = 0L // a new load: don't rewind against the previous book's pause
    super.prepare()
  }

  override fun play() {
    val maxMs = PlayerConfig.autoRewindMaxMs
    if (maxMs > 0 && pausedAt > 0L) {
      val rewind = minOf(maxMs, System.currentTimeMillis() - pausedAt)
      // The rewind is ours, not the listener's move: it must never lower JS's resume floor.
      if (rewind > 500) internal { seekBackBy(rewind) }
    }
    pausedAt = 0L
    super.play()
  }

  override fun pause() {
    pausedAt = System.currentTimeMillis()
    super.pause()
  }

  // Seek by the user-configured Settings intervals (live from PlayerConfig), clamped
  // within the current item/clip - NOT ExoPlayer's build-time fixed increment, which
  // ignored the Settings value (the lock screen always jumped 30s). The increment
  // getters report the same values so anything displaying them stays truthful.
  override fun getSeekBackIncrement(): Long = PlayerConfig.jumpBackwardMs
  override fun getSeekForwardIncrement(): Long = PlayerConfig.jumpForwardMs

  override fun seekBack() = move { seekBackBy(PlayerConfig.jumpBackwardMs) }

  override fun seekForward() = move {
    val max = if (duration != C.TIME_UNSET) duration else Long.MAX_VALUE
    seekTo(minOf(max, currentPosition + PlayerConfig.jumpForwardMs))
  }

  private fun seekBackBy(ms: Long) = seekTo(maxOf(0L, currentPosition - ms))

  // Every seek entry point a controller can reach. ExoPlayer implements the compound ones
  // (seekToPrevious, seekToNextMediaItem...) internally, so each needs its own wrapper.
  override fun seekTo(positionMs: Long) = move { super.seekTo(positionMs) }
  override fun seekTo(mediaItemIndex: Int, positionMs: Long) = move { super.seekTo(mediaItemIndex, positionMs) }
  override fun seekToDefaultPosition() = move { super.seekToDefaultPosition() }
  override fun seekToDefaultPosition(mediaItemIndex: Int) = move { super.seekToDefaultPosition(mediaItemIndex) }
  override fun seekToPrevious() = move { super.seekToPrevious() }
  override fun seekToPreviousMediaItem() = move { super.seekToPreviousMediaItem() }
  override fun seekToNext() = move { super.seekToNext() }
  override fun seekToNextMediaItem() = move { super.seekToNextMediaItem() }

  override fun setPlaybackParameters(playbackParameters: PlaybackParameters) {
    val remote = isRemote()
    super.setPlaybackParameters(playbackParameters)
    if (remote) hooks.onRemoteRate(playbackParameters.speed)
  }

  override fun setPlaybackSpeed(speed: Float) {
    val remote = isRemote()
    super.setPlaybackSpeed(speed)
    if (remote) hooks.onRemoteRate(speed)
  }

  override fun setMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long) {
    if (absorbIdenticalSet) {
      absorbIdenticalSet = false
      if (sameQueue(mediaItems)) return
    }
    pausedAt = 0L
    super.setMediaItems(mediaItems, startIndex, startPositionMs)
    updatePlaylistTitle()
  }

  override fun setMediaItems(mediaItems: MutableList<MediaItem>, resetPosition: Boolean) {
    absorbIdenticalSet = false
    pausedAt = 0L
    super.setMediaItems(mediaItems, resetPosition)
    updatePlaylistTitle()
  }

  override fun setMediaItems(mediaItems: MutableList<MediaItem>) {
    absorbIdenticalSet = false
    pausedAt = 0L
    super.setMediaItems(mediaItems)
    updatePlaylistTitle()
  }

  /** Run [block] as the service's own move: it is never reported as a remote move or rate. */
  fun <T> internal(block: () -> T): T {
    internalDepth++
    try {
      return block()
    } finally {
      internalDepth--
    }
  }

  /** Run [block] attributed to a known origin (custom session commands, which the session does
   * not attribute through `getControllerForCurrentRequest`). */
  fun <T> withOrigin(remote: Boolean, block: () -> T): T {
    val previous = forcedRemote
    forcedRemote = remote
    try {
      return block()
    } finally {
      forcedRemote = previous
    }
  }

  private fun isRemote(): Boolean = internalDepth == 0 && (forcedRemote ?: hooks.isRemoteRequest())

  private inline fun move(block: () -> Unit) {
    val outermost = moveDepth == 0
    val remote = outermost && isRemote()
    moveDepth++
    try {
      block()
    } finally {
      moveDepth--
    }
    if (remote) hooks.onRemoteMove()
  }

  private fun sameQueue(items: List<MediaItem>): Boolean {
    if (items.size != mediaItemCount) return false
    for (i in items.indices) if (items[i].mediaId != getMediaItemAt(i).mediaId) return false
    return true
  }

  /** The playlist (queue) title the car shows above the chapter list: the book's title. */
  private fun updatePlaylistTitle() {
    val title = if (mediaItemCount > 0) MediaItems.bookTitleOf(getMediaItemAt(0)) else null
    super.setPlaylistMetadata(MediaMetadata.Builder().setTitle(title).build())
  }
}
