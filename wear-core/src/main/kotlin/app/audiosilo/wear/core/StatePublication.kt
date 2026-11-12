// Which `watch-state` the phone is still owed, a port of targets/watch/Core/StatePublication.swift.
// A launch starts owing the state whatever it is, so a reinstall or a sign-out corrects a phone
// still holding an older one; after that only a change is owed. A state counts as handed over only
// once the Data Layer took it (the put succeeded): a refused put stays owed and goes at the next
// natural moment (pass 2's PhoneLink), with no timer of its own.
package app.audiosilo.wear.core

class StatePublication {
  /** The state to report: the latest wins. */
  private var latest: WatchState? = null

  /** The one the Data Layer last took, this launch. */
  private var handedOver: WatchState? = null

  /** What to send now, null when the phone already holds the latest (or there is none yet). */
  val due: WatchState?
    @Synchronized get() = if (latest == handedOver) null else latest

  /**
   * Whether it is news: an unchanged state is no moment to try a refused send again, however often
   * a download reports one.
   */
  @Synchronized
  fun update(state: WatchState): Boolean {
    val news = state != latest
    latest = state
    return news
  }

  /** The Data Layer took `state`. */
  @Synchronized
  fun tookIt(state: WatchState) {
    handedOver = state
  }
}
