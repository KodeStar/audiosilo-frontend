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
 *
 * `period` makes the pace one that changes while it runs (the save loop's `saveIntervalMs`
 * in `store.ts`: 15 s or 60 s): how long after the last run the next is due, read at
 * every check, so a change takes effect from the last run with none dropped and none
 * doubled. `ms` is then the shortest it gives, the interval's own pace; a longer period
 * is met by the first check past it (an engine event, about once a second while playing,
 * else the interval). `check()` is such a check, for the caller that knows the period just
 * got shorter, and answers whether it ran; `running()` is whether it is started.
 */
export function engineTicker(fn: () => void, ms: number, period: () => number = () => ms) {
  let lastRun = 0;
  const runIfDue = (now: number): boolean => {
    const every = period();
    if (now - lastRun < every - slackMs(every)) return false;
    lastRun = now;
    fn();
    return true;
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
    running: () => consumers.has(runIfDue),
    check(): boolean {
      return consumers.has(runIfDue) && runIfDue(Date.now());
    },
  };
}

/**
 * A one-shot `setTimeout` that the engine's events drive too, for the same reason as
 * `engineTicker`: `fn` runs once, `ms` after the call, from its timer or from the first
 * engine event past that deadline, whichever comes first (the stall watchdog in `store.ts`,
 * fe#158: with the screen off on Android its timer never fired). `cancel()` takes it off
 * both, and it is off once it has run.
 */
export function engineTimeout(fn: () => void, ms: number): { cancel(): void } {
  const deadline = Date.now() + ms;
  const cancel = () => {
    clearTimeout(timer);
    timeouts.delete(due);
  };
  const fire = () => {
    cancel();
    fn();
  };
  const due = (now: number) => {
    if (now >= deadline) fire();
  };
  const timer = setTimeout(fire, ms);
  timeouts.add(due);
  return { cancel };
}

/** How early a run may come and still count as due: a quarter of the period, at most
 * 100 ms. */
function slackMs(ms: number) {
  return Math.min(ms / 4, 100);
}

/** The running `engineTicker`s. */
const consumers = new Set<(now: number) => void>();
/** The pending `engineTimeout`s, checked before the tickers: the stall watchdog's error
 * halts playback, and the save or the sleep timer must not run first on a stalled start. */
const timeouts = new Set<(now: number) => void>();

/** An engine event arrived (the store calls this on every snapshot it takes): run every
 * `engineTimeout` past its deadline, then every running `engineTicker` that is due. One
 * stopped by an earlier one in this same pass does not run (the sleep timer's fire stops its
 * fade, which must not restore the volume before the pause lands). */
export function engineTick() {
  const now = Date.now();
  runEach(timeouts, now, 'a timeout');
  runEach(consumers, now, 'a ticker');
}

/** Runs each of `set` still in it (one an earlier one cancelled this pass does not run). One
 * throw must not starve the rest this pass, nor escape into the engine's snapshot listener
 * that called `engineTick`. */
function runEach(set: Set<(now: number) => void>, now: number, what: string) {
  for (const run of [...set]) {
    if (!set.has(run)) continue;
    try {
      run(now);
    } catch (err) {
      console.error(`[engineTick] ${what} threw`, err);
    }
  }
}
