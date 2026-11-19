import type { ProxyHeaders } from '@/lib/proxy-headers';
import { connectProxyHeaders } from '@/stores/session';

import { ApiClient, isProxyRefusal } from './client';

/**
 * A bare client for the connect flow at `base` (no token, no reconnect callback: a
 * wrong-password 401 must never flag a connection). It carries the proxy headers entered
 * for `base`'s origin, else the set kept for it (`connectProxyHeaders`, fe#167, one per
 * origin since fe#295), so a server behind an auth proxy answers `/server`, the sign-in and
 * a pairing link's exchange. Any other address (a plain-http fallback, a home address) gets
 * none. `timeoutMs` is for a probe that must give up early (`probeServerId`).
 */
export function connectClient(base: string, timeoutMs?: number): ApiClient {
  return connectClientFor(base, timeoutMs).client;
}

/**
 * `connectClient`, with the set its requests carry (`proxy`, undefined when none goes to
 * `base`, as the client itself decides): what a successful exchange or sign-in went out
 * with, which `finishConnect` keeps as the origin's set when it is the typed one. A
 * reconnect carries the same set as anyone: there is one per origin (fe#295).
 */
export function connectClientFor(
  base: string,
  timeoutMs?: number,
): { client: ApiClient; proxy?: ProxyHeaders } {
  const set = connectProxyHeaders(base);
  const client = new ApiClient(base, null, timeoutMs, undefined, undefined, set);
  return { client, proxy: set && client.proxyHeadersFor(base) ? set : undefined };
}

/** How long `keptSetRefused` waits for the proxy before taking the set as working. */
const KEPT_PROBE_MS = 8000;

/**
 * Whether the proxy in front of `set`'s origin turns that set away now: one tokenless
 * `GET /server` to the origin carrying it, refused by the proxy itself (its own 401 or 403,
 * `isProxyRefusal`). Anything else (an answer, no answer, a timeout) is no sign the set is
 * stale, so false. For a sign-in that may not replace a kept set (a kid's account,
 * `finishConnect`): it keeps its own set for itself only when the kept one is refused.
 */
export async function keptSetRefused(set: ProxyHeaders): Promise<boolean> {
  const client = new ApiClient(set.origin, null, KEPT_PROBE_MS, undefined, undefined, set);
  try {
    await client.serverInfo();
    return false;
  } catch (e) {
    return isProxyRefusal(e);
  }
}
