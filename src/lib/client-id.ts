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
 * Whether to attach `CLIENT_HEADER`. Always on native (no CORS there). On web only
 * when the API base URL is same-origin with the page: a custom header makes a
 * cross-origin request non-simple, so the browser sends a CORS preflight, and
 * servers released before this header existed don't list it in
 * `Access-Control-Allow-Headers` - every cross-origin call from a newer web build
 * would then fail against an older server. The embedded player at `/web` is always
 * same-origin, so it still identifies itself. False when the base URL can't be
 * parsed or there is no page origin.
 */
export function shouldIdentify(
  baseUrl: string,
  platform: string,
  pageOrigin: string | null,
): boolean {
  if (platform !== 'web') return true;
  if (!pageOrigin) return false;
  try {
    return new URL(baseUrl).origin === pageOrigin;
  } catch {
    return false;
  }
}
