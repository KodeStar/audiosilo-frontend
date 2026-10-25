import { type PageLocation, sameOrigin } from './same-origin';

/**
 * The `crossOrigin` a cover `<img>` or the `<audio>` element takes for `url` on the web:
 * `'anonymous'` for an http(s) URL on another origin than the page (the server a player
 * served elsewhere, or a second signed-in server, plays from), so the browser loads it in
 * CORS mode (the server's `cors_origins` grant it, `Access-Control-Allow-Origin`) rather
 * than as an opaque no-cors response. Anonymous: the media token rides in the URL, no
 * cookies. Undefined (no attribute, as before) for a same-origin URL (the player at
 * `/web`, the service worker's `_offline/` copies), a `blob:` or `data:` URL, an
 * unparseable one, and with no page (native: its callers are web-only files).
 */
export function corsModeFor(
  url: string | null | undefined,
  page: PageLocation | null,
): 'anonymous' | undefined {
  if (!url || !page) return undefined;
  let protocol: string;
  try {
    protocol = new URL(url, page.href).protocol;
  } catch {
    return undefined;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return undefined;
  return sameOrigin(url, page) ? undefined : 'anonymous';
}
