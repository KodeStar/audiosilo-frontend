import type { ProxyHeaders } from '@/lib/proxy-headers';
import { connectProxyHeaders } from '@/stores/session';

import { ApiClient } from './client';

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
 * with, which `finishConnect` keeps as the origin's set when it is the typed one.
 * `_reconnectId` is ignored: there is one set per origin (fe#295), so a reconnect carries
 * the same one as anyone (a caller from before that still passes it).
 */
export function connectClientFor(
  base: string,
  timeoutMs?: number,
  _reconnectId?: string,
): { client: ApiClient; proxy?: ProxyHeaders } {
  const set = connectProxyHeaders(base);
  const client = new ApiClient(base, null, timeoutMs, undefined, undefined, set);
  return { client, proxy: set && client.proxyHeadersFor(base) ? set : undefined };
}
