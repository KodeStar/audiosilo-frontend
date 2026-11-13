import { connectProxyHeaders } from '@/stores/session';

import { ApiClient } from './client';

/**
 * A bare client for the connect flow at `base` (no token, no reconnect callback: a
 * wrong-password 401 must never flag a connection). It carries the proxy headers entered
 * for `base`'s origin, or a signed-in connection's for it (`connectProxyHeaders`, fe#167),
 * so a server behind an auth proxy answers `/server`, the sign-in and a pairing link's
 * exchange. Any other address (a plain-http fallback, a home address) gets none.
 * `timeoutMs` is for a probe that must give up early (`probeServerId`). `ownId`: the
 * connection a reconnect signs in again, whose own set (or the one typed for `base`) is the
 * only one it may carry, never another person's.
 */
export function connectClient(base: string, timeoutMs?: number, ownId?: string): ApiClient {
  const proxy = connectProxyHeaders(base, ownId);
  return new ApiClient(base, null, timeoutMs, undefined, undefined, proxy);
}
