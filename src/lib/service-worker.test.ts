/**
 * @jest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// public/sw.js run in a sandbox with an in-memory Cache Storage and a fake network: its
// precache of the split web build (`precacheBuild`) and the cache-first serving of the
// build's hashed files (`cacheFirst`).

const SCOPE = 'https://box.test/web/';
const SW_SOURCE = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

type Store = Map<string, { body: string; headers: [string, string][]; asked: Headers }>;
type Req = string | { url: string; headers?: Headers };

function makeCaches() {
  const caches = new Map<string, Store>();
  const writes: { before?: (url: string) => Promise<void> } = {};
  const urlOf = (r: Req) => (typeof r === 'string' ? r : r.url);
  const headersOf = (r: Req) =>
    typeof r === 'string' ? new Headers() : (r.headers ?? new Headers());
  const open = async (name: string) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const store = caches.get(name)!;
    return {
      // Like Cache Storage: a response stored with `Vary` matches only a request whose named
      // headers equal those of the request it was stored for, unless `ignoreVary`.
      match: async (r: Req, opts: { ignoreVary?: boolean } = {}) => {
        const hit = store.get(urlOf(r));
        if (!hit) return undefined;
        const vary = new Headers(hit.headers).get('vary');
        if (vary && !opts.ignoreVary) {
          const asked = headersOf(r);
          const names = vary.split(',').map((n) => n.trim());
          if (names.some((n) => n === '*' || asked.get(n) !== hit.asked.get(n))) return undefined;
        }
        return new Response(hit.body, { headers: hit.headers });
      },
      put: async (r: Req, res: Response) => {
        await writes.before?.(urlOf(r));
        store.set(urlOf(r), {
          body: await res.text(),
          headers: [...res.headers],
          asked: headersOf(r),
        });
      },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (r: { url: string }) => store.delete(r.url),
    };
  };
  return {
    api: {
      open,
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
    },
    caches,
    writes,
  };
}

type FetchedAs = { url: string; destination: string; headers: Headers };
const js = (p: string) => '_expo/static/js/web/' + p + '.js';
const font = 'assets/fonts/Stacks.abcd.ttf';
const scopeUrl = (p: string) => SCOPE + p;
const cacheName = (id: string) => 'audiosilo-shell-build-' + id;

function build(id: string) {
  return {
    id,
    start: [js('entry-' + id), '_expo/static/css/site.css'],
    routes: [js('book-' + id), js('scan-' + id), js('settings-' + id), js('reader-' + id)],
    fonts: [font],
    catalogs: { fr: js('fr-' + id), de: js('de-' + id) },
  };
}

/** Each install runs a different worker over the same browser's Cache Storage. */
function browser() {
  const { api, caches, writes } = makeCaches();
  const site = new Map<string, string>();
  const offline = new Set<string>();
  const fetched: string[] = [];
  const requests = { active: 0, max: 0 };
  const fetch = async (req: Request | string) => {
    const url = typeof req === 'string' ? req : req.url;
    fetched.push(url);
    requests.max = Math.max(requests.max, ++requests.active);
    await new Promise((done) => setTimeout(done, 1));
    requests.active--;
    if (offline.has(url)) throw new TypeError('offline');
    const body = site.get(url);
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(body, {
      headers: url.endsWith('.ttf') ? { vary: 'Origin' } : undefined,
    });
  };
  function worker(id: string, language = 'fr') {
    const manifest = build(id);
    const shell = manifest.start
      .map((file) => '<script src="/web/' + file + '"></script>')
      .join('');
    site.set(SCOPE, shell);
    for (const file of [
      ...manifest.start,
      ...manifest.routes,
      ...manifest.fonts,
      ...Object.values(manifest.catalogs),
      'reader.html',
    ])
      site.set(scopeUrl(file), file);
    const self = {
      location: new URL(SCOPE + 'sw.js?lang=' + language),
      registration: { scope: SCOPE },
      addEventListener: () => {},
    };
    const ctx = vm.createContext({ self, caches: api, fetch, Request, Response, URL, Headers });
    vm.runInContext(
      SW_SOURCE.replace('/* precache manifest */ null', JSON.stringify(manifest)),
      ctx,
    );
    return ctx as unknown as {
      installBuild(): Promise<void>;
      retireBuilds(): Promise<void>;
      handleNavigation(
        r: Request,
        shellFallback: boolean,
        event: { waitUntil: (p: Promise<void>) => void },
      ): Promise<Response>;
      cacheFirst(r: Request | FetchedAs): Promise<Response>;
      staleWhileRevalidate(r: FetchedAs): Promise<Response>;
      serveAsset(r: FetchedAs, url: URL): Promise<Response>;
    };
  }
  const cached = (id: string) => [...(caches.get(cacheName(id))?.keys() ?? [])];
  return { api, caches, cached, writes, site, offline, fetched, requests, worker };
}

it('precaches the chosen language first, caps transfers, and fetches other catalogs only on use', async () => {
  const t = browser();
  const sw = t.worker('a');
  await sw.installBuild();
  const m = build('a');
  expect(t.fetched.slice(0, 2)).toEqual([SCOPE, scopeUrl(m.catalogs.fr)]);
  expect(t.requests.max).toBe(4);
  expect(t.cached('a')).toEqual(
    expect.arrayContaining([SCOPE, ...m.routes.map(scopeUrl), scopeUrl(font)]),
  );
  expect(t.fetched).not.toContain(scopeUrl(m.catalogs.de));
  const german = new Request(scopeUrl(m.catalogs.de));
  expect(await (await sw.cacheFirst(german)).text()).toBe(m.catalogs.de);
  t.offline.add(german.url);
  expect(await (await sw.cacheFirst(german)).text()).toBe(m.catalogs.de);
});

it('preserves the current offline build through a partial update and retries on the next install', async () => {
  const t = browser();
  const a = t.worker('a');
  await a.installBuild();
  const old = t.cached('a');
  const b = t.worker('b');
  t.offline.add(scopeUrl(js('scan-b')));
  await expect(b.installBuild()).rejects.toThrow('offline');
  expect(t.cached('a')).toEqual(old);
  expect(t.caches.has(cacheName('b'))).toBe(false);
  t.offline.clear();
  await b.installBuild();
  await b.retireBuilds();
  expect(t.cached('b')).toContain(SCOPE);
  expect(t.cached('a')).not.toContain(SCOPE);
  t.offline.add(scopeUrl(js('scan-a')));
  expect(await (await b.cacheFirst(new Request(scopeUrl(js('scan-a'))))).text()).toBe(js('scan-a'));
  // A same-build language change keeps the old tab's files too.
  const again = t.worker('b', 'de');
  t.fetched.length = 0;
  await again.installBuild();
  await again.retireBuilds();
  expect(t.fetched).toEqual([SCOPE, scopeUrl(build('b').catalogs.de), scopeUrl('reader.html')]);
  expect(t.cached('a')).toContain(scopeUrl(js('scan-a')));
  const c = t.worker('c');
  await c.installBuild();
  await c.retireBuilds();
  expect(t.caches.has(cacheName('a'))).toBe(false);
  expect(t.cached('b')).toContain(scopeUrl(js('scan-b')));
});

it('cleans up an uncommitted build when the final shell write fails, preserving both generations on a rollback', async () => {
  const t = browser();
  const a = t.worker('a');
  await a.installBuild();
  const b = t.worker('b');
  await b.installBuild();
  await b.retireBuilds();
  t.writes.before = async (url) => {
    if (url === SCOPE) throw new Error('quota');
  };
  await expect(t.worker('c').installBuild()).rejects.toThrow('quota');
  expect(t.caches.has(cacheName('c'))).toBe(false);
  // A failed rollback may have reopened the retired build's cache, which has no root.
  await expect(t.worker('a').installBuild()).rejects.toThrow('quota');
  expect(t.cached('a')).toContain(scopeUrl(js('scan-a')));
  expect(t.cached('b')).toContain(SCOPE);
});

it('upgrades the legacy worker, removing its record and private or stale pages while keeping downloads and old tab assets', async () => {
  const t = browser();
  const legacy = await t.api.open('audiosilo-shell-v1');
  const oldScript = scopeUrl(js('old'));
  for (const url of [
    SCOPE,
    oldScript,
    SCOPE + '__precached-build',
    SCOPE + 'library',
    SCOPE + 'connect?token=one',
    SCOPE + 'connect?oidc=1&flow=two',
    oldScript + '?token=secret',
  ]) {
    await legacy.put(url, new Response('old'));
  }
  const media = await t.api.open('audiosilo-media-v1');
  const track = SCOPE + '_offline/track';
  await media.put(track, new Response('audio'));
  await t.api.open('other-app');
  const a = t.worker('a');
  await a.installBuild();
  await a.retireBuilds();
  expect(await legacy.keys()).toEqual([{ url: oldScript }]);
  expect(await (await a.cacheFirst(new Request(oldScript))).text()).toBe('old');
  expect(await (await media.match(track))?.text()).toBe('audio');
  expect(t.caches.has('other-app')).toBe(true);
  const b = t.worker('b');
  await b.installBuild();
  await b.retireBuilds();
  expect(t.caches.has('audiosilo-shell-v1')).toBe(false);
});

it('carries a working offline reader and its policy forward when its update request fails', async () => {
  const t = browser();
  const url = scopeUrl('reader.html');
  const legacy = await t.api.open('audiosilo-shell-v1');
  await legacy.put(
    url,
    new Response('<reader>', { headers: { 'Content-Security-Policy': "connect-src 'none'" } }),
  );
  t.offline.add(url);
  const sw = t.worker('a');
  await sw.installBuild();
  await sw.retireBuilds();
  const response = await sw.handleNavigation(new Request(url), false, { waitUntil: () => {} });
  expect(response.headers.get('content-security-policy')).toBe("connect-src 'none'");
  expect(await response.text()).toBe('<reader>');
});

it('copies an Origin-varied font into the new build without refetching and serves it offline', async () => {
  const t = browser();
  const url = scopeUrl(font);
  const request = {
    url,
    destination: 'font',
    headers: new Headers({ Origin: 'https://box.test' }),
  };
  const legacy = await t.api.open('audiosilo-shell-v1');
  await legacy.put(request, new Response('font-bytes', { headers: { Vary: 'Origin' } }));
  const sw = t.worker('a');
  t.offline.add(url);
  await sw.installBuild();
  await sw.retireBuilds();
  expect(t.fetched).not.toContain(url);
  expect(await (await sw.serveAsset(request, new URL(url))).text()).toBe('font-bytes');
  // A varied image never receives the answer kept for a different request.
  const image = { ...request, destination: 'image' };
  expect((await sw.staleWhileRevalidate(image)).status).toBe(504);
});

it('installs without an unavailable font and keeps a working shell when a deployment changes mid-install', async () => {
  const t = browser();
  const sw = t.worker('a');
  t.offline.add(scopeUrl(font));
  await sw.installBuild();
  expect(t.cached('a')).toContain(SCOPE);
  expect(t.cached('a')).not.toContain(scopeUrl(font));
  const b = t.worker('b');
  t.site.set(SCOPE, '<p>newer deploy</p>');
  await expect(b.installBuild()).rejects.toThrow('does not match build');
  expect(t.cached('a')).toContain(SCOPE);
  expect(t.caches.has(cacheName('b'))).toBe(false);
});

it('streams a fresh navigation even if saving its offline copy is slow and fails', async () => {
  const t = browser();
  const sw = t.worker('a');
  await sw.installBuild();
  const page = SCOPE + 'library';
  t.site.set(page, t.site.get(SCOPE)!);
  let release!: () => void;
  t.writes.before = () =>
    new Promise<void>((_, reject) => {
      release = () => reject(new Error('quota'));
    });
  const writes: Promise<void>[] = [];
  const event = { waitUntil: (work: Promise<void>) => writes.push(work) };
  const response = await sw.handleNavigation(new Request(page), true, event);
  expect(await response.text()).toBe(t.site.get(SCOPE));
  expect(writes).toHaveLength(1);
  await new Promise((done) => setTimeout(done, 0));
  release();
  await Promise.all(writes);
  expect(t.cached('a')).not.toContain(page);
  t.writes.before = async () => {
    throw new Error('quota');
  };
  const german = build('a').catalogs.de;
  expect(await (await sw.cacheFirst(new Request(scopeUrl(german)))).text()).toBe(german);
});

it('revalidates a runtime image while using the cached bytes', async () => {
  const t = browser();
  const sw = t.worker('a');
  const url = SCOPE + 'icons/icon-192.png';
  t.site.set(url, 'png');
  const request = { url, destination: 'image', headers: new Headers() };
  expect(await (await sw.serveAsset(request, new URL(url))).text()).toBe('png');
  await sw.serveAsset(request, new URL(url));
  expect(t.fetched).toEqual([url, url]);
});
