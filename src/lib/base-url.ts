/**
 * The app's base path at runtime.
 *
 * Production web exports are served under `EXPO_BASE_URL` (the Go server mounts the
 * player at `/web`), so asset/manifest/service-worker urls must be prefixed with it.
 * The Metro dev server (`expo start --web`), however, serves everything at the root
 * and ignores `baseUrl` — so in development the base must be empty, or links like
 * `/web/manifest.json` 404. Hence the NODE_ENV split rather than EXPO_BASE_URL alone.
 */
export const BASE_URL =
  process.env.NODE_ENV === 'production' ? (process.env.EXPO_BASE_URL ?? '') : '';

/** True under the Metro dev server (`expo start --web`). */
export const IS_DEV = process.env.NODE_ENV !== 'production';
