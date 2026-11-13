import { cleanProxyHeaders, type ProxyHeader, type ProxyHeaders } from '@/lib/proxy-headers';
import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';

/**
 * Where a connection's proxy headers (fe#167, `proxy-headers.ts`) live: the same storage as
 * its session token (`secure-store`: the keychain or keystore, written readable after the
 * first unlock on iOS so CarPlay can stream on a locked phone; localStorage on the web),
 * one JSON item per connection. They go with the connection (sign-out, a retired identity,
 * the auth reset: `src/stores/session.ts`) and move with it (`identity-migration.ts`).
 */

/** The secure-store key of a connection's headers. */
export const proxyHeadersKey = (connectionId: string) => `audiosilo.proxy-headers.${connectionId}`;

/**
 * A connection's stored set, or null (none, or not the shape this build writes). A read
 * the platform refuses (a locked keychain) REJECTS: the session's hydrate must fail as it
 * does for the token, never go on as if the connection had no headers.
 */
export async function readProxyHeaders(connectionId: string): Promise<ProxyHeaders | null> {
  const raw = await getSecure(proxyHeadersKey(connectionId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ProxyHeaders> | null;
    return cleanProxyHeaders(v?.origin, v?.headers as ProxyHeader[] | undefined);
  } catch {
    return null;
  }
}

/** Keep `set` as the connection's headers; null (or an empty set) deletes them. */
export async function saveProxyHeaders(
  connectionId: string,
  set: ProxyHeaders | null,
): Promise<void> {
  if (!set?.headers.length) {
    await deleteSecure(proxyHeadersKey(connectionId));
    return;
  }
  await setSecure(
    proxyHeadersKey(connectionId),
    JSON.stringify({ origin: set.origin, headers: set.headers }),
  );
}

/** Forget a connection's headers. Best-effort: a locked keychain must not fail a sign-out. */
export async function forgetProxyHeaders(connectionId: string): Promise<void> {
  await deleteSecure(proxyHeadersKey(connectionId)).catch(() => undefined);
}

/** Move a connection's headers to the id it moved to (the identity migration), keeping a
 * set already there. Best-effort, never rejects; the old key never outlives the move. */
export async function moveProxyHeaders(from: string, to: string): Promise<void> {
  try {
    const set = await readProxyHeaders(from);
    if (set && !(await readProxyHeaders(to))) await saveProxyHeaders(to, set);
  } catch {
    // Not kept under the new id: the Account page offers to add them again.
  }
  await forgetProxyHeaders(from);
}
