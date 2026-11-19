import { resolveConnectionId } from '@/lib/connection-id';

import { ApiError } from './client';

/**
 * The server's rate limit (a 429), held per connection: a replay of queued saves that hits
 * it stops there (the rest of its group waits), and the connection's queued saves wait out
 * the answer's `Retry-After` before a replay sends any again (`queuedRoute`), rather than
 * asking again at once with every later save (fe#173). Per connection (one person on one
 * server: the server limits an authenticated route per credential), never per `ApiClient`:
 * `resolveClient` builds a client per call, so a hold kept on one was gone by the next
 * replay. Under the connection's id now (`resolveConnectionId`): a queued save naming the id
 * the identity migration moved it from is held by the same wait. Once the wait is over that
 * connection's queues are replayed (`onRateLimitOver`, told its id now): nothing else may
 * come to send what it held (the reader closed meanwhile, the app left open). Dropped with
 * its connection (`forgetRateLimit`); in memory only, so the next app start sends again.
 */

/** How long a 429 with no `Retry-After` (or one the browser can't expose) holds, seconds. */
export const RATE_LIMIT_HOLD_S = 30;

/** The longest a `Retry-After` is taken to hold, seconds: a far-off one is still a wait for
 * this session only, and the next app start sends again. */
export const RATE_LIMIT_MAX_HOLD_S = 600;

/** The shortest hold, seconds: a `Retry-After: 0` (a proxy's) would replay straight back into
 * the limit, again and again. */
const RATE_LIMIT_MIN_HOLD_S = 1;

const holds = new Map<string, number>();
const wakes = new Map<string, ReturnType<typeof setTimeout>>();
const overListeners = new Set<(connectionId: string) => void>();

/** Note `e` when it is the server's rate limit (a 429): `connectionId`'s queued saves wait
 * out its `Retry-After` from `now`. Whether it was one. */
export function noteRateLimit(connectionId: string, e: unknown, now = Date.now()): boolean {
  if (!(e instanceof ApiError) || e.status !== 429) return false;
  const asked = e.retryAfterSeconds ?? RATE_LIMIT_HOLD_S;
  const wait = Math.min(Math.max(asked, RATE_LIMIT_MIN_HOLD_S), RATE_LIMIT_MAX_HOLD_S) * 1000;
  const id = resolveConnectionId(connectionId);
  holds.set(id, now + wait);
  wakeAfter(id, wait);
  return true;
}

/** Tell `onRateLimitOver`'s listeners once `connectionId`'s wait is over, `ms` from now. */
function wakeAfter(connectionId: string, ms: number): void {
  clearTimeout(wakes.get(connectionId));
  wakes.set(
    connectionId,
    setTimeout(() => {
      wakes.delete(connectionId);
      // A timer can fire a little before the clock says the wait is over.
      const left = (holds.get(connectionId) ?? 0) - Date.now();
      if (rateLimited(connectionId)) {
        wakeAfter(connectionId, left);
        return;
      }
      // Its id now: the identity migration can have moved it since the wait began.
      for (const listener of overListeners) listener(resolveConnectionId(connectionId));
    }, ms),
  );
}

/** Whether a replay's failed send of one save stops the rest of its group: no answer (the
 * server is unreachable), or the server's rate limit, the connection's and not this save's
 * (noted, so the connection waits out its `Retry-After`). Any other answer, even a 500, is
 * that save's own failure, and the rest still go. */
export function stopsReplay(connectionId: string, e: unknown): boolean {
  return !(e instanceof ApiError) || noteRateLimit(connectionId, e);
}

/** Whether `connectionId`'s server asked to wait (a 429) and the wait is not over at `now`.
 * One further ahead than any is noted for (the clock set back since) is over too, as a
 * queue claim is (`claimStands`): it would hold for as long as the clock went back. */
export function rateLimited(connectionId: string, now = Date.now()): boolean {
  const id = resolveConnectionId(connectionId);
  const until = holds.get(id);
  if (until === undefined) return false;
  if (now < until && until - now <= RATE_LIMIT_MAX_HOLD_S * 1000) return true;
  holds.delete(id);
  return false;
}

/** Run `listener` with the connection (its id now, `resolveConnectionId`) whenever a wait a
 * 429 asked for is over (a replay of what it held, that connection's only). Returns the
 * unsubscribe. */
export function onRateLimitOver(listener: (connectionId: string) => void): () => void {
  overListeners.add(listener);
  return () => {
    overListeners.delete(listener);
  };
}

/** Drop `connectionId`'s wait (the connection is gone): a sign-in again starts with none. */
export function forgetRateLimit(connectionId: string): void {
  const id = resolveConnectionId(connectionId);
  holds.delete(id);
  clearTimeout(wakes.get(id));
  wakes.delete(id);
}
