import { type ApiClient, ApiError } from './client';

/**
 * The server's rate limit (a 429), held per client: a replay of queued saves that hits it
 * stops there (the rest of its group waits), and the client's queued saves wait out the
 * answer's `Retry-After` before any is sent again, rather than asking again at once with
 * every later save (fe#173). Per client object, so a client built anew (a re-pair, a new
 * address) starts with none, and nothing outlives it.
 */

/** How long a 429 with no `Retry-After` (or one the browser can't expose) holds, seconds. */
export const RATE_LIMIT_HOLD_S = 30;

/** The longest a `Retry-After` is taken to hold, seconds: a far-off one is still a wait for
 * this session only, and the next app start sends again. */
export const RATE_LIMIT_MAX_HOLD_S = 600;

const holds = new WeakMap<ApiClient, number>();

/** Note `e` when it is the server's rate limit (a 429): `client`'s queued saves wait out its
 * `Retry-After` from `now`. Whether it was one. */
export function noteRateLimit(client: ApiClient, e: unknown, now = Date.now()): boolean {
  if (!(e instanceof ApiError) || e.status !== 429) return false;
  const wait = Math.min(e.retryAfterSeconds ?? RATE_LIMIT_HOLD_S, RATE_LIMIT_MAX_HOLD_S);
  holds.set(client, now + wait * 1000);
  return true;
}

/** Whether `client`'s server asked to wait (a 429) and the wait is not over at `now`. */
export function rateLimited(client: ApiClient, now = Date.now()): boolean {
  const until = holds.get(client);
  if (until === undefined) return false;
  if (now < until) return true;
  holds.delete(client);
  return false;
}
