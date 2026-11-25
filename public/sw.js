/*
 * AudioSilo service worker. The web export embeds its own precache list.
 *
 * Two jobs:
 *  1. App shell - make the PWA installable and loadable offline: network-first for
 *     navigations (falling back to a cached shell that boots the SPA), cache-first for the
 *     content-hashed Expo build files (`_expo/static/`, `cacheFirst`), and
 *     stale-while-revalidate for other same-origin assets. The web build is split (Expo
 *     Router async routes): a page's chunks load when it is first opened, so route chunks
 *     are precached for a page never opened online. Other languages load on use.
 *  2. Offline media - serve downloaded audio/cover files that the web download
 *     engine (src/downloads/engine.web.ts) stored in MEDIA_CACHE under synthetic
 *     `…/_offline/…` urls, honouring HTTP Range so <audio> can seek (and so Safari,
 *     which refuses a 200 for media, will play at all).
 *
 * Metro emits the production worker at <base>/sw.js. Dev serves this file as written.
 */

const BUILD = /* precache manifest */ null;
const BUILD_PREFIX = 'audiosilo-shell-build-';
const LEGACY_CACHE = 'audiosilo-shell-v1';
const SHELL_CACHE = BUILD ? BUILD_PREFIX + BUILD.id : LEGACY_CACHE;
const MEDIA_CACHE = 'audiosilo-media-v1'; // keep in sync with engine.web.ts
// The media-auth query param (keep in sync with client.ts `mediaTokenQuery`): its
// presence marks a token-bearing URL that must never be written into Cache Storage.
const TOKEN_PARAM = 'token';
// A page address carrying any of these is never written into Cache Storage either: a pairing
// link's `token` (`/connect?token=`, the server's `web_url`: its own param, named as the media
// one is), and the key of a single sign-on's flow its return names
// (`/connect?oidc=1&flow=<key>`, server#406). Each is one-time, so a kept copy would only hold
// the value (one more page per sign-in), and offline such a page boots from the app shell.
const UNKEPT_PAGE_PARAMS = ['token', 'flow'];

// Registered with `?dev=1` under the Metro dev server. In dev we only serve offline
// media (so downloads are testable via `npm run web`) and never cache the app shell,
// so the worker can't serve a stale bundle and break hot reloading.
const DEV = new URL(self.location.href).searchParams.get('dev') === '1';

// Asset request destinations we cache (the build's own files cache-first, the rest
// stale-while-revalidate). API calls (destination '')
// and audio streamed from the server pass straight through to the network.
const CACHEABLE = new Set(['script', 'style', 'font', 'image', 'manifest']);

// The build's own files, content-hashed: `<base>/_expo/static/...`.
const BUILD_ASSETS = '/_expo/static/';

// Requests the worker never answers skip it entirely (the Static Routing API, Chrome 123+;
// elsewhere the fetch handler's own early return still passes them through). This is not only
// speed: in Chrome a keepalive POST from a page this worker controls, sent as the page goes
// away (the listening span `endHistory` posts on pagehide, v2.5.1 PLAYER-14), is dispatched
// here first, and the network fallback dies with the page, so the span never left the
// browser. Routed to the network up front, it is sent like on a page with no worker.
const NETWORK_ONLY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Registers the network-only routes; a browser without `addRoutes` (or one refusing a rule)
 * keeps the fetch handler's pass-through, so this never fails the install. Async, yet the
 * call itself runs before the first await, so while the install event is dispatched. */
async function addNetworkRoutes(event) {
  try {
    await event.addRoutes?.(
      NETWORK_ONLY_METHODS.map((requestMethod) => ({
        condition: { requestMethod },
        source: 'network',
      })),
    );
  } catch {
    // Unsupported or refused: the fetch handler still passes these requests through.
  }
}

self.addEventListener('install', (event) => {
  // Before the precache: `addRoutes` must be called while the install event is dispatched.
  const routed = addNetworkRoutes(event);
  event.waitUntil(
    (async () => {
      await routed;
      if (!DEV) {
        try {
          await installBuild();
        } catch (error) {
          // A failed install keeps the working worker. With none (a first visit), install
          // anyway: downloaded media plays only through a worker, and the next online page
          // of this build completes the precache (`repairBuild`).
          if (self.registration.active) throw error;
        }
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (!DEV) await retireBuilds();
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
    // The ebook reader's document (Bridge Phase 3b, framed by the reader screen) is its own
    // page under its own CSP: never answer it with the app shell, which would boot the
    // whole app inside the reader's frame.
    event.respondWith(handleNavigation(request, !isReaderDocument(url), event));
  } else if (CACHEABLE.has(request.destination)) {
    // Never persist token-bearing media (covers embed ?token=): the session token
    // would be written into Cache Storage, and every entry turns into unreachable
    // garbage the moment the token rotates. Let the browser fetch these directly.
    if (url.searchParams.has(TOKEN_PARAM)) return;
    event.respondWith(serveAsset(request, url, event));
  }
  // else: let the browser handle it (API requests, server-streamed audio, …)
});

// --- app shell -------------------------------------------------------------

/** The ebook reader's document, relative to the scope (public/reader.html). */
const READER_DOCUMENT = 'reader.html';

/** Whether `url` is the ebook reader's document. */
function isReaderDocument(url) {
  return url.pathname === new URL(READER_DOCUMENT, self.registration.scope).pathname;
}

/** Network first, then this page's own cached copy, then (`shellFallback`) the app shell. */
async function handleNavigation(request, shellFallback, event) {
  let fresh;
  try {
    fresh = await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match(request)) ||
      (shellFallback ? await cache.match(self.registration.scope) : undefined) ||
      new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    );
  }
  if (fresh.ok && !carriesOneTimeValue(request.url)) {
    // The page can stream to the browser while its copy is checked and saved. A full
    // cache may lose this offline copy but cannot lose the successful network response.
    const copy = fresh.clone();
    const save = async () => {
      if (shellFallback && !(await matchesBuild(copy.clone()))) return;
      // The server still serves this build: put its precache back if it went missing.
      if (shellFallback) await repairBuild();
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, copy);
    };
    event.waitUntil(save().catch(() => {}));
  }
  return fresh;
}

/** Whether a page's address carries a one-time value (`UNKEPT_PAGE_PARAMS`). */
function carriesOneTimeValue(url) {
  const { searchParams } = new URL(url);
  return UNKEPT_PAGE_PARAMS.some((p) => searchParams.has(p));
}

/** A good same-origin answer, safe to keep. */
function cacheable(res) {
  return res.ok && (res.type === 'basic' || res.type === 'default');
}

/**
 * A cacheable file's answer. The build's own files and its fonts are named by their content
 * (the export hashes every asset's name), so a cached one is never stale: served from the
 * cache and never fetched or written again (a rewrite would drop the compiled code Chrome
 * keeps for a script cached at install, and a font read again behind every load cost two
 * requests a font, its preload and its `@font-face`: fe#358). Anything else is served from
 * the cache and read again behind it.
 */
function serveAsset(request, url, event) {
  return url.pathname.includes(BUILD_ASSETS) || request.destination === 'font'
    ? cacheFirst(request, event)
    : staleWhileRevalidate(request);
}

async function cacheFirst(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  // A font is precached under the worker's own request, which has no Origin, and the server
  // answers fonts with `Vary: Origin`; the page's font request is CORS mode, so it carries
  // one, and a strict match would miss offline (fe#177). A font file is the same bytes
  // whatever asks, so it ignores Vary. Only fonts are precached under a request unlike the
  // page's; everything else keeps to Vary, which costs nothing and serves no varied answer
  // to a request it was not given for.
  const options = { ignoreVary: request.destination === 'font' };
  const cached = await cache.match(request, options);
  if (cached) return cached;
  if (immutableAsset(request.url)) {
    const previous = await matchPrevious(request, options);
    if (previous) return previous;
  }
  const res = await fetch(request);
  if (cacheable(res)) {
    const save = cache.put(request, res.clone()).catch(() => {});
    event?.waitUntil(save);
  }
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && cacheable(res)) cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached || (await network) || new Response('', { status: 504 });
}

// --- the build's chunks ------------------------------------------------------

const PRECACHE_CONCURRENCY = 4;

function otherBuilds(names) {
  return names.filter(
    (name) => name !== SHELL_CACHE && (name.startsWith(BUILD_PREFIX) || name === LEGACY_CACHE),
  );
}

/** Only immutable, same-scope build files may be served from a previous generation. The
 * font rule matches the manifest's (scripts/web-precache.cjs `fonts`): keep them in step. */
function immutableAsset(url) {
  const { href, search } = new URL(url);
  const scope = self.registration.scope;
  return (
    !search &&
    (href.startsWith(scope + BUILD_ASSETS.slice(1)) ||
      (href.startsWith(scope + 'assets/') && /\.(ttf|otf|woff2?)$/i.test(href)))
  );
}

async function matchPrevious(request, options) {
  for (const name of otherBuilds(await caches.keys())) {
    const previous = await caches.open(name);
    const hit = await previous.match(request, options);
    if (hit) return hit;
  }
}

/** The mandatory start scripts and CSS are named in every static route's HTML. A page
 * from a newer deployment can be shown online, but it cannot replace this offline shell. */
async function matchesBuild(response) {
  const html = await response.text();
  return BUILD.start.length > 0 && BUILD.start.every((file) => html.includes(file));
}

let repairing;

/** Install this build again when its offline root is gone. Another worker on this origin
 * can delete every cache but its own (the admin console's, scope "/", on activation), and
 * the same worker bytes never install again until the next deploy. One repair at a time. */
function repairBuild() {
  repairing ??= (async () => {
    if ((await caches.keys()).includes(SHELL_CACHE)) {
      const cache = await caches.open(SHELL_CACHE);
      if (await cache.match(self.registration.scope)) return;
    }
    await installBuild();
  })().finally(() => {
    repairing = undefined;
  });
  return repairing;
}

/** Install in a separate cache. A required file going missing rejects the install, so
 * the browser keeps its working worker and retries the update on a later visit. */
async function installBuild() {
  const scope = self.registration.scope;
  const shell = await fetch(new Request(scope, { cache: 'no-cache' }));
  // A redirected root would be refused as the answer to an offline navigation.
  if (!cacheable(shell) || shell.redirected || !(await matchesBuild(shell.clone()))) {
    throw new Error('Offline shell does not match build');
  }

  const existed = (await caches.keys()).includes(SHELL_CACHE);
  const cache = await caches.open(SHELL_CACHE);
  const language = new URL(self.location.href).searchParams.get('lang');
  const files = [
    ...(Object.hasOwn(BUILD.catalogs, language) ? [BUILD.catalogs[language]] : []),
    ...BUILD.start,
    ...BUILD.fonts,
    ...BUILD.routes,
    READER_DOCUMENT,
  ];
  const fonts = new Set(BUILD.fonts);
  const pending = files.values();
  // A required file failed: the install is over, so the other transfers take no more files.
  let stopped = false;
  async function takeFiles() {
    for (const file of pending) {
      if (stopped) return;
      const url = new URL(file, scope).href;
      const font = fonts.has(file);
      const reader = file === READER_DOCUMENT;
      try {
        // Changing language installs another worker over the same build. Only its
        // missing catalog needs fetching; keep the scripts already compiled here.
        if (existed && !reader && (await cache.match(url, { ignoreVary: font }))) continue;
        // A page may already have fetched the font with a different Origin header.
        // Copy those bytes forward; a script cached at install also keeps Chrome's code.
        let response;
        if (font) {
          response = await matchPrevious(url, { ignoreVary: true });
        }
        response ??= await fetch(new Request(url, { cache: reader ? 'reload' : 'default' }));
        if (!cacheable(response) || response.redirected) throw new Error('Precache failed: ' + url);
        await cache.put(url, response);
      } catch (error) {
        if (!font && !reader) {
          stopped = true;
          throw error;
        }
        // A book already downloaded keeps opening in the reader if this server cannot
        // send a new reader document. Its cached response carries the reader's own CSP.
        if (reader && !(await cache.match(url))) {
          const previous = await matchPrevious(url);
          if (previous) await cache.put(url, previous);
        }
      }
    }
  }
  // Let all four transfers settle before removing an incomplete cache.
  const results = await Promise.allSettled(Array.from({ length: PRECACHE_CONCURRENCY }, takeFiles));
  const failed = results.find((result) => result.status === 'rejected');
  try {
    if (failed) throw failed.reason;
    await cache.put(scope, shell);
  } catch (error) {
    if (!existed) await caches.delete(SHELL_CACHE);
    throw error;
  }
}

/** A completed build has its offline root. On activation retain the last such build
 * for tabs still running it, with only its immutable assets. An update to the worker
 * alone can reuse its build cache and the already-retired previous one. */
async function retireBuilds() {
  const others = otherBuilds(await caches.keys());
  let previous = others.at(-1);
  for (const name of others) {
    const cache = await caches.open(name);
    if (await cache.match(self.registration.scope)) previous = name;
  }
  for (const name of others) {
    if (name !== previous) {
      await caches.delete(name);
      continue;
    }
    const cache = await caches.open(name);
    // Also drops the old worker's build record, stale HTML and one-time addresses.
    const stale = (await cache.keys()).filter((request) => !immutableAsset(request.url));
    await Promise.all(stale.map((request) => cache.delete(request)));
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
