/*
 * AudioSilo service worker (hand-written, no build step).
 *
 * Two jobs:
 *  1. App shell - make the PWA installable and loadable offline: network-first for
 *     navigations (falling back to a cached shell that boots the SPA), and
 *     stale-while-revalidate for the content-hashed Expo assets.
 *  2. Offline media - serve downloaded audio/cover files that the web download
 *     engine (src/downloads/engine.web.ts) stored in MEDIA_CACHE under synthetic
 *     `…/_offline/…` urls, honouring HTTP Range so <audio> can seek (and so Safari,
 *     which refuses a 200 for media, will play at all).
 *
 * Expo static export copies public/ verbatim, so this is served at <base>/sw.js
 * and its scope is <base>/.
 */

const SHELL_CACHE = 'audiosilo-shell-v1';
const MEDIA_CACHE = 'audiosilo-media-v1'; // keep in sync with engine.web.ts
// The media-auth query param (keep in sync with client.ts `mediaTokenQuery`): its
// presence marks a token-bearing URL that must never be written into Cache Storage.
const TOKEN_PARAM = 'token';

// Registered with `?dev=1` under the Metro dev server. In dev we only serve offline
// media (so downloads are testable via `npm run web`) and never cache the app shell,
// so the worker can't serve a stale bundle and break hot reloading.
const DEV = new URL(self.location.href).searchParams.get('dev') === '1';

// Asset request destinations we cache-and-revalidate. API calls (destination '')
// and audio streamed from the server pass straight through to the network.
const CACHEABLE = new Set(['script', 'style', 'font', 'image', 'manifest']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (!DEV) {
        const cache = await caches.open(SHELL_CACHE);
        try {
          // Precache the shell root so offline navigations have something to fall
          // back to; hashed assets fill in at runtime on first online visit.
          await cache.add(new Request(self.registration.scope, { cache: 'reload' }));
        } catch {
          // first install offline / root unreachable - runtime caching covers it
        }
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, MEDIA_CACHE]);
      const names = await caches.keys();
      // Drop old shell versions but never the media cache (downloads must survive).
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/_offline/')) {
    event.respondWith(serveMedia(request));
    return;
  }
  if (DEV) return; // dev: leave the app shell to the network so HMR is unaffected

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
  } else if (CACHEABLE.has(request.destination)) {
    // Never persist token-bearing media (covers embed ?token=): the session token
    // would be written into Cache Storage, and every entry turns into unreachable
    // garbage the moment the token rotates. Let the browser fetch these directly.
    if (url.searchParams.has(TOKEN_PARAM)) return;
    event.respondWith(staleWhileRevalidate(request));
  }
  // else: let the browser handle it (API requests, server-streamed audio, …)
});

// --- app shell -------------------------------------------------------------

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    // Only cache a good response as the app shell - caching a transient 5xx would
    // then be served for offline navigations instead of the shell fallback.
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return (
      (await cache.match(request)) ||
      (await cache.match(self.registration.scope)) ||
      new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
        cache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => undefined);
  return cached || (await network) || new Response('', { status: 504 });
}

// --- offline media ---------------------------------------------------------

async function serveMedia(request) {
  const cache = await caches.open(MEDIA_CACHE);
  // The cached entry was stored with no Vary, so this matches by url regardless of
  // the request's Range header.
  const cached = await cache.match(request);
  if (!cached) return new Response('Offline media not found', { status: 404 });

  const range = request.headers.get('range');
  return range ? buildPartialResponse(cached, range) : cached;
}

/**
 * Slice a fully-cached response to satisfy a `Range` request → 206 (or 416).
 * Slices the Blob lazily (`blob.slice` is O(1) and streams only the requested
 * bytes) rather than reading the whole file into an ArrayBuffer per request -
 * critical for large audiobooks, where the latter stalls seeks for seconds.
 */
async function buildPartialResponse(response, rangeHeader) {
  const blob = await response.blob();
  const size = blob.size;

  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return new Response(blob, { headers: response.headers });

  let start = m[1] === '' ? NaN : parseInt(m[1], 10);
  let end = m[2] === '' ? NaN : parseInt(m[2], 10);
  if (Number.isNaN(start)) {
    // suffix range: bytes=-N → last N bytes
    const suffix = Number.isNaN(end) ? 0 : end;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (Number.isNaN(end) || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}
