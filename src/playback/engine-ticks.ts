import { ticker } from '@/lib/ticker';

/**
 * A `ticker` that the playback engine's own events drive too.
 *
 * Android pauses every JS timer while the activity is paused (React Native's
 * `JavaTimerManager.onHostPause`): with the screen off or another app in front, no
 * `setInterval` fires, so anything playback runs on one stops while the book plays on.
 * On a Pixel, two minutes of screen-off listening saved no progress, and a sleep timer
 * would never fade or pause the book. The engine's events still reach JS there (the
 * native module's progress loop is a native handler, about once a second while playing),
 * and the store hands every one of them to `engineTick`.
 *
 * So each of these runs from whichever comes first, its interval or an engine event, at
 * most once per `ms` by the wall clock: both read and move ONE last-run time, so the two
 * never both run inside one interval. The interval stays for the web, iOS and the
 * foreground; the events are the backstop. `start()` is idempotent and does not re-base
 * (the `ticker` contract); `stop()` takes it off both.
 *
 * "Due" allows a little slack (`slackMs`): an interval or an event that lands a few ms
 * short of a full `ms` after the last run (timer jitter, an event cadence of about `ms`)
 * still runs. Without it, every run that came slightly later than the one before it
 * would skip a whole period - a 1 s countdown stepping every 2 s.
 */
export function engineTicker(fn: () => void, ms: number) {
  let lastRun = 0;
  const due = ms - slackMs(ms);
  const runIfDue = (now: number) => {
    if (now - lastRun < due) return;
    lastRun = now;
    fn();
  };
  const interval = ticker(() => runIfDue(Date.now()), ms);
  return {
    start() {
      if (consumers.has(runIfDue)) return;
      lastRun = Date.now();
      consumers.add(runIfDue);
      interval.start();
    },
    stop() {
      consumers.delete(runIfDue);
      interval.stop();
    },
  };
}

/** How early a run may come and still count as due: a quarter of the period, at most
 * 100 ms. */
function slackMs(ms: number) {
  return Math.min(ms / 4, 100);
}

/** The running `engineTicker`s. */
const consumers = new Set<(now: number) => void>();

/** An engine event arrived (the store calls this on every snapshot it takes): run every
 * running `engineTicker` that is due. One stopped by an earlier one in this same pass
 * does not run (the sleep timer's fire stops its fade, which must not restore the volume
 * before the pause lands). */
export function engineTick() {
  const now = Date.now();
  for (const run of [...consumers]) {
    if (!consumers.has(run)) continue;
    // One consumer's throw must not starve the rest this pass, nor escape into the
    // engine's snapshot listener that called this.
    try {
      run(now);
    } catch (err) {
      console.error('[engineTick] a ticker threw', err);
    }
  }
}
