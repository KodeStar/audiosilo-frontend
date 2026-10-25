import { Platform } from 'react-native';

import type { PageLocation } from './same-origin';

/** The page the web player runs in, null on native (where nothing loads in CORS mode). */
function webPage(): PageLocation | null {
  return Platform.OS === 'web' && typeof location !== 'undefined' ? location : null;
}

/**
 * The `crossOrigin` a cover `<img>` or the `<audio>` element takes for `url` on the web:
 * `'anonymous'` for an http(s) URL on another origin than the page (the server a player
 * served elsewhere, or a second signed-in server, plays from), so the browser loads it in
 * CORS mode (the server's `cors_origins` grant it, `Access-Control-Allow-Origin`) rather
 * than as an opaque no-cors response. Anonymous: the media token rides in the URL, no
 * cookies. Undefined (no attribute, as before) for a same-origin URL (the player at
 * `/web`, the service worker's `_offline/` copies), a `blob:` or `data:` URL, an
 * unparseable one, and always on native.
 */
export function corsModeFor(
  url: string | null | undefined,
  page: PageLocation | null = webPage(),
): 'anonymous' | undefined {
  if (!url || !page) return undefined;
  try {
    const target = new URL(url, page.href);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined;
    return target.origin === page.origin ? undefined : 'anonymous';
  } catch {
    return undefined;
  }
}
