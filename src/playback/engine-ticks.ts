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
 */
export function engineTicker(fn: () => void, ms: number) {
  let lastRun = 0;
  const runIfDue = (now: number) => {
    if (now - lastRun < ms) return;
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

/** The running `engineTicker`s. */
const consumers = new Set<(now: number) => void>();

/** An engine event arrived (the store calls this on every snapshot it takes): run every
 * running `engineTicker` that is due. One stopped by an earlier one in this same pass
 * does not run (the sleep timer's fire stops its fade, which must not restore the volume
 * before the pause lands). */
export function engineTick() {
  const now = Date.now();
  for (const run of [...consumers]) if (consumers.has(run)) run(now);
}
