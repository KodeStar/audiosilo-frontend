import { ApiClient } from '@/api/client';
import { connectProxyHeaders } from '@/stores/session';

/**
 * A bare client for the connect flow at `base` (no token, no reconnect callback: a
 * wrong-password 401 must never flag a connection). It carries the proxy headers entered
 * for `base`'s origin, or a signed-in connection's for it (`connectProxyHeaders`, fe#167),
 * so a server behind an auth proxy answers `/server`, the sign-in and a pairing link's
 * exchange. Any other address (a plain-http fallback, a home address) gets none.
 */
export function connectClient(base: string): ApiClient {
  return new ApiClient(base, null, undefined, undefined, undefined, connectProxyHeaders(base));
}
