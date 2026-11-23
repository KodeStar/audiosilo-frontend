import { withTimeout } from '@/lib/with-timeout';
import { recoverOpenSpan } from './listening-outbox';

/** How long a reader of this device's places waits for the launch's recovery of a span a
 * kill left open (`recoverOpenSpan`). The recovery is local, but on the web it waits its
 * turn behind every other tab's span writes (`spanOps`). */
export const SPAN_RECOVERY_WAIT_MS = 2_000;

/** The bounded wait for each recovery (one per launch, `recoverOpenSpan` keeps it), so its
 * readers share one deadline: a reader that waited for it, then a start it makes (Previously
 * on, the car), never waits out a recovery that never ends twice. */
const bounded = new WeakMap<Promise<void>, Promise<void>>();

/**
 * Wait for the span a kill left open to be brought into the mirror (`mirrorSpanEnd`), for a
 * reader about to read this device's places (a start, the book page, the car's play specs),
 * but never longer than `SPAN_RECOVERY_WAIT_MS` from the first reader's wait: past it every
 * reader goes on with the places as they are, and the recovery lands later as it would have
 * (a start never hangs on it). (`recoverOpenSpan` never rejects: only the timeout does, and
 * is taken as over.)
 */
export function spanRecovered(): Promise<void> {
  const recovery = recoverOpenSpan();
  let wait = bounded.get(recovery);
  if (!wait) {
    wait = withTimeout(recovery, SPAN_RECOVERY_WAIT_MS, 'span recovery').catch(() => undefined);
    bounded.set(recovery, wait);
  }
  return wait;
}
