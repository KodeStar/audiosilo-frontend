package expo.modules.audiosiloplayer

import kotlin.math.abs

/**
 * The JS moves (`seekTo`, `skipToTrack`) resolve once the controller reported the new place
 * (fe#351), never as soon as their main-thread post is queued: a progress tick sent from the
 * place before would otherwise reach JS after the call resolved, and the store would read a
 * tick from before a seek back as the engine having played on from the asked place.
 *
 * [run] makes a move and waits for its own landing, never another's: a lock-screen or car
 * seek reports the same seek discontinuity. A MediaController masks a seek, so the move's
 * discontinuity comes inside the seek call itself ([landed] while [run] is in [move]): the
 * move took, and so did every earlier one still waiting (it is past them). One reported after
 * the call is the move's only at its target ([Target]). A move never reported within
 * [FALLBACK_MS] was not taken (the controller lacked the seek command, or dropped it): it
 * settles with `taken = false`, which JS reads as a refused move, so the store does not count
 * the engine as at a place it never reached. [schedule] and [cancel] are the main-thread
 * handler's (one thread: no locking).
 */
internal class MoveLandings(
  private val schedule: (Runnable, Long) -> Unit,
  private val cancel: (Runnable) -> Unit,
) {
  /** Where a move asked the controller to go: its media item and the place in it. */
  data class Target(val item: Int, val positionMs: Long)

  private class Waiting(val target: Target, val done: (Boolean) -> Unit)

  private val waiting = mutableListOf<Waiting>()
  private val fallback = Runnable { settleAll(taken = false) }
  /** A move is being made ([run] is in its `move`), and whether its discontinuity came. */
  private var moving = false
  private var landedInMove = false

  /** Run [move], which makes the seek and returns its target, then [done] with whether the
   * controller took it: at once when it reported the seek inside the call, else once it
   * reports one at the target, or `false` after [FALLBACK_MS] (or when [move] threw). */
  fun run(done: (taken: Boolean) -> Unit, move: () -> Target) {
    moving = true
    landedInMove = false
    val target = try {
      move()
    } catch (e: Exception) {
      moving = false
      done(false)
      throw e
    }
    moving = false
    if (landedInMove) {
      // Taken, and past every move still waiting.
      settleAll(taken = true)
      done(true)
      return
    }
    waiting.add(Waiting(target, done))
    cancel(fallback)
    schedule(fallback, FALLBACK_MS)
  }

  /** The controller reported a seek's new place: the move being made, or a waiting one whose
   * target it is. Any other (a lock-screen or car seek) settles nothing. */
  fun landed(item: Int, positionMs: Long) {
    if (moving) {
      landedInMove = true
      return
    }
    val mine = waiting.filter {
      it.target.item == item && abs(it.target.positionMs - positionMs) <= NEAR_MS
    }
    if (mine.isEmpty()) return
    waiting.removeAll(mine)
    if (waiting.isEmpty()) cancel(fallback)
    mine.forEach { it.done(true) }
  }

  private fun settleAll(taken: Boolean) {
    // The fallback is only ever scheduled while a move waits.
    if (waiting.isEmpty()) return
    cancel(fallback)
    val done = waiting.toList()
    waiting.clear()
    done.forEach { it.done(taken) }
  }

  companion object {
    /** Longer than a masked seek's discontinuity ever takes to come. */
    const val FALLBACK_MS = 1_000L
    /** How near a reported place is to a move's target to be its landing (a seek lands on a
     * sample, a little off the asked millisecond). */
    const val NEAR_MS = 500L
  }
}
