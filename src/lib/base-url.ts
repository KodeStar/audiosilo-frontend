import { Platform } from 'react-native';

import { sameOrigin } from '@/lib/same-origin';

/**
 * The app's base path at runtime.
 *
 * Production web exports are served under `EXPO_BASE_URL` (the Go server mounts the
 * player at `/web`), so asset/manifest/service-worker urls must be prefixed with it.
 * The Metro dev server (`expo start --web`), however, serves everything at the root
 * and ignores `baseUrl` - so in development the base must be empty, or links like
 * `/web/manifest.json` 404. Hence the NODE_ENV split rather than EXPO_BASE_URL alone.
 */
export const BASE_URL =
  process.env.NODE_ENV === 'production' ? (process.env.EXPO_BASE_URL ?? '') : '';

/** A web address's `pathname` inside the app: the base path (`BASE_URL`) off. */
export function appPath(pathname: string, base = BASE_URL): string {
  return base && pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
}

/** True under the Metro dev server (`expo start --web`). */
export const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Origin the web build is served from (which is also its API base in the web /
 * demo flows). `null` on native, where the server address must arrive explicitly
 * (e.g. a pairing link's `server` param) rather than being inferred from the host.
 */
export function webOrigin(): string | null {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin.replace(/\/+$/, '');
  }
  return null;
}

/** The production player's own origin. It can host the server or just the static web export. */
export function productionWebOrigin(): string | null {
  return IS_DEV ? null : webOrigin();
}

/**
 * Whether the served player (`origin`, from `productionWebOrigin()`) is signed in only to its own
 * server, so it has no other server to add. A production web build hosted on an origin of its
 * own, beside servers whose CORS let it in (the test bed's static web host), is signed in
 * elsewhere and still adds servers.
 */
export function onlyOwnServer(origin: string | null, serverUrls: readonly string[]): boolean {
  return (
    origin !== null &&
    serverUrls.length > 0 &&
    serverUrls.every((url) => sameOrigin(url, { origin }))
  );
}

/** A static player can ask for a server elsewhere. If /api answers like a static host,
 * check the player document independently: the server serves it under connect-src 'self',
 * even when a proxy routes /api to the wrong place. An unreadable document is inconclusive. */
export async function playerAllowsOtherServers(signal?: AbortSignal): Promise<boolean> {
  const ask = new AbortController();
  const cancel = () => ask.abort();
  const timeout = setTimeout(cancel, 2500);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel);
  try {
    const res = await fetch(`${BASE_URL}/`, {
      method: 'HEAD',
      mode: 'same-origin',
      redirect: 'error',
      signal: ask.signal,
    });
    if (!res.ok) return false;
    const policy = res.headers.get('Content-Security-Policy') ?? '';
    return !/(?:^|[;,])\s*connect-src\s+'self'\s*(?:[;,]|$)/i.test(policy);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
