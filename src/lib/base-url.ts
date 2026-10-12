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

/**
 * The server this web build was served by, or `null`. A production web build is the player the
 * server serves at `/web`, so its origin IS the server, and the server's CSP (`connect-src
 * 'self'`) lets it reach no other: there is no address to ask for and no second server to add.
 * `null` on native and under the Metro dev server, which is not the server.
 */
export function servedOrigin(): string | null {
  return IS_DEV ? null : webOrigin();
}

/**
 * Whether the served player (`origin`, from `servedOrigin()`) is signed in only to its own
 * server, so it has no other server to add. A production web build hosted on an origin of its
 * own, beside servers whose CORS let it in (the test bed's static web host), is signed in
 * elsewhere and still adds servers.
 */
export function onlyOwnServer(origin: string | null, serverUrls: readonly string[]): boolean {
  return origin !== null && serverUrls.every((url) => sameOrigin(url, { origin }));
}
