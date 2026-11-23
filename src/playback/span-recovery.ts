import { withTimeout } from '@/lib/with-timeout';
import { recoverOpenSpan } from './listening-outbox';

/** How long a reader of this device's places waits for the launch's recovery of a span a
 * kill left open (`recoverOpenSpan`). The recovery is local, but on the web it waits its
 * turn behind every other tab's span writes (`spanOps`). */
export const SPAN_RECOVERY_WAIT_MS = 2_000;

/**
 * Wait for the span a kill left open to be brought into the mirror (`mirrorSpanEnd`), for a
 * reader about to read this device's places (a resume, the book page, the car's play specs),
 * but never longer than `SPAN_RECOVERY_WAIT_MS`: past it the reader goes on with the places
 * as they are, and the recovery lands later as it would have (a resume never hangs on it).
 * (`recoverOpenSpan` never rejects: only the timeout does, and is taken as over.)
 */
export function spanRecovered(): Promise<void> {
  return withTimeout(recoverOpenSpan(), SPAN_RECOVERY_WAIT_MS, 'span recovery').catch(
    () => undefined,
  );
}
