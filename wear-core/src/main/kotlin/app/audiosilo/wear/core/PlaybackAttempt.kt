// A playback deadline belongs to the attempt that armed it, a port of
// targets/watch/Core/PlaybackAttempt.swift. Pausing, resuming or replacing the queue invalidates
// its callbacks, even when the queue still holds the same first item. `PlaybackFailure` says what
// a failed play means in plain words; on Wear it reads Media3's `PlaybackException.errorCode`
// (mirrored below, so this file stays pure; :wear's tests check the values against Media3's).
package app.audiosilo.wear.core

import java.io.FileNotFoundException

class PlaybackAttempt {
  var generation: Int = 0
    private set

  fun advance(): Int {
    generation += 1
    return generation
  }

  fun accepts(token: Int): Boolean = token == generation

  /** The deadline armed by `token` has passed with the audio still not started while playing. */
  fun timedOut(token: Int, settling: Boolean, playing: Boolean): Boolean = accepts(token) && settling && playing
}

enum class PlaybackFailure(val message: String) {
  AUDIO_START("The watch could not start its audio. Play again."),
  SETTLING("This book did not start playing. Play again."),
  DAMAGED_DOWNLOAD("This download can't be read. Remove it from the watch and download it again.");

  companion object {
    // Media3's PlaybackException error codes that mean the file itself is gone or unreadable.
    const val ERROR_CODE_IO_FILE_NOT_FOUND = 2005
    const val ERROR_CODE_PARSING_CONTAINER_MALFORMED = 3001
    const val ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED = 3003
    const val ERROR_CODE_DECODING_FAILED = 4003

    private val DAMAGED =
      setOf(
        ERROR_CODE_IO_FILE_NOT_FOUND,
        ERROR_CODE_PARSING_CONTAINER_MALFORMED,
        ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        ERROR_CODE_DECODING_FAILED,
      )

    /**
     * A player error. Only a file that is gone, or whose audio cannot be parsed or decoded, is a
     * damaged download (another Play fails the same way); other player failures can be temporary
     * and keep the book for another Play. The cause chain is read too (a missing file can come
     * wrapped in another code).
     */
    fun ofError(errorCode: Int, cause: Throwable? = null): PlaybackFailure {
      if (errorCode in DAMAGED) return DAMAGED_DOWNLOAD
      var next = cause
      var depth = 0
      while (next != null && depth < 4) {
        if (next is FileNotFoundException) return DAMAGED_DOWNLOAD
        next = next.cause
        depth += 1
      }
      return AUDIO_START
    }
  }
}

/**
 * Why the audio stopped without the listener asking (W4 decision 10): read from Media3's change
 * reasons, so the span ends where the audio last moved, not when the stop was noticed.
 */
enum class Halt {
  /** Another app took audio focus for good (a pause; the listener plays again). */
  FOCUS_LOST,

  /** A call or an alert took focus for a while: Media3 plays on by itself when it ends. */
  FOCUS_TRANSIENT,

  /** Headphones went away (`ACTION_AUDIO_BECOMING_NOISY`). */
  NOISY,

  /** The only output is one the listener has not chosen (the built-in speaker, decision 10). */
  UNSUITABLE_OUTPUT,

  /** Media3 gave up waiting while suppressed (`SUPPRESSED_TOO_LONG`). */
  SUPPRESSED_TOO_LONG,

  /** Anything else the player did by itself. */
  OTHER,
}

object SystemPause {
  // Media3's Player constants, mirrored (Player.PLAY_WHEN_READY_CHANGE_REASON_*).
  const val PWR_USER_REQUEST = 1
  const val PWR_AUDIO_FOCUS_LOSS = 2
  const val PWR_AUDIO_BECOMING_NOISY = 3
  const val PWR_REMOTE = 4
  const val PWR_END_OF_MEDIA_ITEM = 5
  const val PWR_SUPPRESSED_TOO_LONG = 6

  // Player.PLAYBACK_SUPPRESSION_REASON_*.
  const val SUPPRESSION_NONE = 0
  const val SUPPRESSION_TRANSIENT_AUDIO_FOCUS_LOSS = 1
  const val SUPPRESSION_UNSUITABLE_AUDIO_OUTPUT = 3

  /**
   * `playWhenReady` went false with `reason` while the listener wanted it to play: what stopped it.
   * Null for the listener's own pause (a user request reaches the engine first, never here, but a
   * controller's is still the listener's).
   */
  fun ofPlayWhenReady(reason: Int): Halt? =
    when (reason) {
      PWR_USER_REQUEST -> null
      PWR_AUDIO_FOCUS_LOSS -> Halt.FOCUS_LOST
      PWR_AUDIO_BECOMING_NOISY -> Halt.NOISY
      PWR_SUPPRESSED_TOO_LONG -> Halt.SUPPRESSED_TOO_LONG
      else -> Halt.OTHER
    }

  /** A suppression reason while playing: what holds the audio, null when nothing does (or one this app ignores). */
  fun ofSuppression(reason: Int): Halt? =
    when (reason) {
      SUPPRESSION_TRANSIENT_AUDIO_FOCUS_LOSS -> Halt.FOCUS_TRANSIENT
      SUPPRESSION_UNSUITABLE_AUDIO_OUTPUT -> Halt.UNSUITABLE_OUTPUT
      else -> null
    }

  /**
   * Whether the listener's wish to play stands through it: Media3 resumes by itself after a
   * transient focus loss, so only the span closes (and a new one opens when the audio moves again).
   * Every other halt is a pause.
   */
  fun keepsPlaying(halt: Halt): Boolean = halt == Halt.FOCUS_TRANSIENT

  /** Whether to ask the one-time speaker question: the speaker is the only output and not confirmed yet. */
  fun asksSpeaker(halt: Halt?, speakerConfirmed: Boolean): Boolean = halt == Halt.UNSUITABLE_OUTPUT && !speakerConfirmed

  /** What Now Playing says after it, null when the pause speaks for itself. */
  fun message(halt: Halt): String? =
    when (halt) {
      Halt.SUPPRESSED_TOO_LONG -> "Paused while no headphones were connected. Play again."
      else -> null
    }
}
