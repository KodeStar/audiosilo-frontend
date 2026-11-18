package expo.modules.audiosiloplayer

/**
 * The JS moves (`seekTo`, `skipToTrack`) resolve once the controller reported the new place
 * (fe#351), never as soon as their main-thread post is queued: a progress tick sent from the
 * place before would otherwise reach JS after the call resolved, and the store would read a
 * tick from before a seek back as the engine having played on from the asked place.
 *
 * [run] makes a move and waits for its landing: the controller's next seek discontinuity
 * ([landed], after its progress sample went out). A MediaController masks a seek, so that
 * discontinuity comes inside the seek call itself and the move resolves as [run] returns;
 * one that never comes resolves after [FALLBACK_MS], so no JS call waits forever.
 * [schedule] and [cancel] are the main-thread handler's (one thread: no locking).
 */
internal class MoveLandings(
  private val schedule: (Runnable, Long) -> Unit,
  private val cancel: (Runnable) -> Unit,
) {
  private val waiting = mutableListOf<() -> Unit>()
  private val fallback = Runnable { resolveAll() }

  /** Run [move], then [done] once it landed (or [move] threw). */
  fun run(done: () -> Unit, move: () -> Unit) {
    waiting.add(done)
    try {
      move()
    } catch (e: Exception) {
      resolveAll()
      throw e
    }
    if (waiting.isNotEmpty()) {
      cancel(fallback)
      schedule(fallback, FALLBACK_MS)
    }
  }

  /** The controller reported a seek's new place: every move waiting has landed. */
  fun landed() = resolveAll()

  private fun resolveAll() {
    // The fallback is only ever scheduled while a move waits.
    if (waiting.isEmpty()) return
    cancel(fallback)
    val done = waiting.toList()
    waiting.clear()
    done.forEach { it() }
  }

  companion object {
    /** Longer than a masked seek's discontinuity ever takes to come. */
    const val FALLBACK_MS = 1_000L
  }
}
