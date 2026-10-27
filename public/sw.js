/*
 * AudioSilo service worker (hand-written, no build step).
 *
 * Two jobs:
 *  1. App shell - make the PWA installable and loadable offline: network-first for
 *     navigations (falling back to a cached shell that boots the SPA), and
 *     stale-while-revalidate for the content-hashed Expo assets. The web build is split
 *     (Expo Router async routes): a page's chunks load when it is first opened, so every
 *     chunk of the build is precached (`precacheBuild`) for a page never opened online.
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
        // The shell root (offline navigations fall back to it) and the build's chunks,
        // cached while installing so Chrome keeps their compiled code (see precacheBuild).
        // Offline or the root unreachable: runtime caching covers it, and the app asks again.
        await precacheBuild(true);
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

// The app asks once it has started (`register-sw.web.ts`): a new build is deployed under
// the same worker (sw.js itself unchanged, so no new install), and its chunks are precached
// here instead.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'precache' && !DEV) event.waitUntil(precacheBuild());
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
    // The ebook reader's document (Bridge Phase 3b, framed by the reader screen) is its own
    // page under its own CSP: never answer it with the app shell, which would boot the
    // whole app inside the reader's frame.
    event.respondWith(handleNavigation(request, !isReaderDocument(url)));
  } else if (CACHEABLE.has(request.destination)) {
    // Never persist token-bearing media (covers embed ?token=): the session token
    // would be written into Cache Storage, and every entry turns into unreachable
    // garbage the moment the token rotates. Let the browser fetch these directly.
    if (url.searchParams.has(TOKEN_PARAM)) return;
    // The build's own files are content-hashed, so a cached one is never stale: served from
    // the cache and never written again (a rewrite would drop the compiled code Chrome
    // keeps for a script cached at install).
    event.respondWith(
      url.pathname.includes('/_expo/static/') ? cacheFirst(request) : staleWhileRevalidate(request),
    );
  }
  // else: let the browser handle it (API requests, server-streamed audio, …)
});

// --- app shell -------------------------------------------------------------

/** Whether `url` is the ebook reader's document (`<scope>reader.html`, public/reader.html). */
function isReaderDocument(url) {
  return url.pathname === new URL('reader.html', self.registration.scope).pathname;
}

/** Network first, then this page's own cached copy, then (`shellFallback`) the app shell. */
async function handleNavigation(request, shellFallback = true) {
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
      (shellFallback ? await cache.match(self.registration.scope) : undefined) ||
      new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && (res.type === 'basic' || res.type === 'default')) cache.put(request, res.clone());
  return res;
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

// --- the build's chunks ------------------------------------------------------

// The cache entry recording the build last precached: the shell's own scripts and styles.
const PRECACHED_BUILD = '__precached-build';
// A build asset named in the HTML or a chunk: `<base>/_expo/static/js/web/<name>-<hash>.js`
// (the chunk map Expo writes into the entry and into chunks that load others) or a
// stylesheet under `_expo/static/css/`.
const ASSET_REF = /["'](\/(?:[^"'\s]*?\/)?_expo\/static\/(?:js|css)\/[^"'\s]+?\.(?:js|css))["']/g;

/** The same-origin build assets `text` names, as absolute URLs. */
function assetRefs(text) {
  const urls = new Set();
  for (const m of text.matchAll(ASSET_REF)) urls.add(new URL(m[1], self.location.origin).href);
  return [...urls];
}

/**
 * Precache every chunk of the build the shell (the scope's index.html) boots: its scripts
 * and stylesheets, then every chunk they name, transitively. A route opened for the first
 * time offline then still finds its chunk, and a deep link still boots. The previous
 * build's chunks are dropped once this one is complete. Offline or failing part way, it
 * stops and leaves the record unwritten, so the next ask finishes it.
 *
 * At install (`fresh`) every file is written again, even one already cached: Chrome
 * compiles a script a worker caches while installing and keeps the code with it, so the
 * next start skips most of its compiling (the app registers the worker under its build's
 * name, so each deploy installs one). Otherwise (the app's ask) a hashed file already
 * cached is not fetched again, and a shell naming the same files as last time is done.
 */
async function precacheBuild(fresh = false) {
  try {
    const cache = await caches.open(SHELL_CACHE);
    const shell = self.registration.scope;
    const res = await fetch(new Request(shell, { cache: 'no-cache' }));
    if (!res.ok) return;
    await cache.put(shell, res.clone());
    const roots = assetRefs(await res.text());
    if (!roots.length) return;
    const build = roots.slice().sort().join('\n');
    const marker = new URL(PRECACHED_BUILD, shell).href;
    const done = await cache.match(marker);
    if (!fresh && done && (await done.text()) === build) return;

    const seen = new Set();
    const queue = [...roots];
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      let asset = fresh ? undefined : await cache.match(url);
      if (!asset) {
        asset = await fetch(url);
        if (!asset.ok) return;
        await cache.put(url, asset.clone());
      }
      if (url.endsWith('.js')) queue.push(...assetRefs(await asset.text()));
    }
    for (const request of await cache.keys()) {
      if (request.url.includes('/_expo/static/') && !seen.has(request.url)) {
        await cache.delete(request);
      }
    }
    await cache.put(marker, new Response(build));
  } catch {
    // offline or the server gone: the next ask (the app's next start) tries again
  }
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
