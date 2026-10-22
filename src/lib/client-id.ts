import { sameOrigin } from '@/lib/same-origin';

/**
 * Client identification: every API request tells the server which app made it, so
 * the server can record it against the session token. Pure helpers; `ApiClient`
 * decides when to attach the header.
 */

/** Request header carrying the client identity. */
export const CLIENT_HEADER = 'X-AudioSilo-Client';

/**
 * The header value, e.g. `AudioSilo/1.4.2 (ios)`. An empty version (Constants
 * unavailable) falls back to `dev`.
 */
export function clientIdentity(version: string, platform: string): string {
  return `AudioSilo/${version || 'dev'} (${platform})`;
}

/**
 * The cross-origin dev loop's opt-in (`npm run web` on :8081 against a server elsewhere):
 * a development build with `EXPO_PUBLIC_IDENTIFY_CROSS_ORIGIN=1` identifies itself
 * cross-origin too, so a server that shows podcasts only to a player new enough for them
 * (Bridge Phase 2d-1, `auth.PodcastPlayerMinVersion`) shows them there. The server's CORS
 * allows the header; an older one would fail the preflight, which is why it is opt-in. Never
 * in a production build, whatever the environment says.
 */
function identifiesCrossOrigin(): boolean {
  return __DEV__ && process.env.EXPO_PUBLIC_IDENTIFY_CROSS_ORIGIN === '1';
}

/**
 * Whether to attach `CLIENT_HEADER`. Always on native (no CORS there). On web only
 * when the API base URL is same-origin with the page: a custom header makes a
 * cross-origin request non-simple, so the browser sends a CORS preflight, and
 * servers released before this header existed don't list it in
 * `Access-Control-Allow-Headers` - every cross-origin call from a newer web build
 * would then fail against an older server. The embedded player at `/web` is always
 * same-origin, so it still identifies itself. False when the base URL can't be
 * parsed or there is no page origin. A development build can opt in cross-origin
 * (`identifiesCrossOrigin`).
 */
export function shouldIdentify(
  baseUrl: string,
  platform: string,
  pageOrigin: string | null,
): boolean {
  if (platform !== 'web') return true;
  if (identifiesCrossOrigin()) return true;
  return sameOrigin(baseUrl, pageOrigin ? { origin: pageOrigin } : null);
}
