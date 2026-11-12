// When the outbox is sent, Wear's twin of targets/watch/Core/BackgroundSync.swift (W4 decision 9).
// The Apple Watch hands a body built ahead to a background upload session; Wear runs a WorkManager
// worker (unique work `sync`, any network) that flushes the outbox itself, so each attempt builds a
// fresh body with its own `sent_at`, and it can run the home probe, so a home address is allowed in
// the background too. What triggers a send:
//  - in the foreground: launch (after the open span is recovered), coming to the foreground, each
//    closed span, and every 60 s while events wait (the reconnect trigger);
//  - in the background: an expedited worker when a span closes with events unsent or the app goes
//    to the background with events unsent, and a 15 minute periodic backstop while events wait
//    (the `WKApplicationRefreshBackgroundTask` twin), cancelled once nothing does.
// `NetworkCallback` only triggers a try: the send itself is the connectivity test (W3 decision).
package app.audiosilo.wear.core

object SyncSchedule {
  /** The unique work name of the sync worker (one at a time). */
  const val UNIQUE_WORK = "sync"

  /** The unique work name of the periodic backstop. */
  const val PERIODIC_WORK = "sync-periodic"

  /** In the foreground, how often a send is tried while events wait. */
  const val FOREGROUND_RETRY: Double = 60.0

  /** The backstop's period (WorkManager's minimum). */
  const val PERIODIC_MINUTES: Long = 15

  enum class Trigger {
    /** The app started (its open span already recovered into the outbox). */
    LAUNCH,

    /** The app came to the foreground. */
    FOREGROUND,

    /** A span closed (its event is in the outbox). */
    SPAN_CLOSED,

    /** The app went to the background. */
    BACKGROUND,

    /** The 60 s foreground timer while events wait. */
    TIMER,

    /** A network came up (a trigger only, never a gate). */
    NETWORK,
  }

  /** What to do for one trigger. */
  data class Plan(
    /** Flush now, in the app's process. */
    val flushNow: Boolean,
    /** Enqueue the expedited sync worker. */
    val expedite: Boolean,
    /** Keep the periodic backstop scheduled (else cancel it). */
    val backstop: Boolean,
  )

  fun plan(trigger: Trigger, unsent: Int, inForeground: Boolean): Plan {
    val waiting = unsent > 0
    if (!waiting) return Plan(flushNow = false, expedite = false, backstop = false)
    // Going to the background hands the send to the worker; anything else sends from the app when
    // it is in front, else from the worker.
    val inApp = inForeground && trigger != Trigger.BACKGROUND
    return Plan(flushNow = inApp, expedite = !inApp, backstop = true)
  }

  /** Whether the 60 s foreground timer runs: only while events wait and the app is in front. */
  fun foregroundTimer(unsent: Int, inForeground: Boolean): Boolean = unsent > 0 && inForeground
}
