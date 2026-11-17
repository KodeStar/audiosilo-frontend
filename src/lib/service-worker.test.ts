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
  return { api: { open, keys: async () => [...caches.keys()] }, caches };
}

/** `site`: what the server answers per url; `headers`: the headers it adds to some. */
function load(site: Record<string, string>, headers: Record<string, Record<string, string>> = {}) {
  const fetched: string[] = [];
  const offline = new Set<string>();
  const fetch = jest.fn(async (r: string | Request) => {
    const url = typeof r === 'string' ? r : r.url;
    fetched.push(url);
    if (offline.has(url)) throw new TypeError('offline');
    const body = site[url];
    return body === undefined
      ? new Response('', { status: 404 })
      : new Response(body, { headers: headers[url] });
  });
  const { api, caches } = makeCaches();
  const self = {
    location: new URL(`${SCOPE}sw.js?build=index-e1`),
    registration: { scope: SCOPE },
    addEventListener: () => {},
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const ctx = vm.createContext({ self, caches: api, fetch, Request, Response, URL, Headers });
  vm.runInContext(SW_SOURCE, ctx);
  const sw = ctx as unknown as {
    precacheBuild: (fresh?: boolean) => Promise<void>;
    cacheFirst: (r: Request) => Promise<Response>;
    staleWhileRevalidate: (r: Request | FetchedAs) => Promise<Response>;
  };
  const cached = () => [...(caches.get('audiosilo-shell-v1') ?? new Map()).keys()].sort();
  /** A page `handleNavigation` cached while online. */
  const cachePage = async (url: string, html: string) =>
    (await api.open('audiosilo-shell-v1')).put(
      url,
      new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );
  return { sw, fetched, offline, cached, cachePage, site };
}

/** A request as the page sends it: Node's `Request` has no destination and no Origin. */
type FetchedAs = { url: string; destination: string; headers: Headers };

const js = (p: string) => `https://box.test/web/_expo/static/js/web/${p}.js`;
const css = 'https://box.test/web/_expo/static/css/global-c1.css';

/** A build: the shell names its scripts and stylesheet; the entry names the route chunks
 * (Expo's chunk map), and one chunk names another. */
function build(id: string) {
  return {
    [SCOPE]: `<link rel="preload" href="/web/_expo/static/css/global-c1.css" as="style">
      <script src="/web/_expo/static/js/web/__common-${id}.js" defer></script>
      <script src="/web/_expo/static/js/web/index-${id}.js" defer></script>`,
    [css]: 'body{}',
    [js(`__common-${id}`)]: '__d(function(){})',
    [js(`index-${id}`)]:
      `var paths={"1":"/web/_expo/static/js/web/book-${id}.js","2":"/web/_expo/static/js/web/scan-${id}.js"}`,
    [js(`book-${id}`)]: '__d(function(){})',
    [js(`scan-${id}`)]: `x("/web/_expo/static/js/web/zxing-${id}.js")`,
    [js(`zxing-${id}`)]: '__d(function(){})',
  };
}

describe('service worker: precacheBuild', () => {
  it('caches the shell and every chunk the build names, transitively', async () => {
    const { sw, cached } = load(build('a'));
    await sw.precacheBuild(true);
    expect(cached()).toEqual(
      [
        SCOPE,
        `${SCOPE}__precached-build`,
        css,
        js('__common-a'),
        js('index-a'),
        js('book-a'),
        js('scan-a'),
        js('zxing-a'),
      ].sort(),
    );
  });

  it('does nothing more for a build it has precached, when the app asks', async () => {
    const { sw, fetched } = load(build('a'));
    await sw.precacheBuild(true);
    fetched.length = 0;
    await sw.precacheBuild();
    expect(fetched).toEqual([SCOPE]);
  });

  it('writes every file again at install, even one cached already', async () => {
    const { sw, fetched } = load(build('a'));
    await sw.precacheBuild();
    fetched.length = 0;
    await sw.precacheBuild(true);
    expect(fetched).toContain(js('book-a'));
  });

  it("takes a new build's chunks, keeps the one before one deploy longer, drops older", async () => {
    const t = load(build('a'));
    await t.sw.precacheBuild(true);
    Object.assign(t.site, build('b'));
    await t.sw.precacheBuild();
    expect(t.cached()).toContain(js('zxing-b'));
    // A tab still running build a (another tab installed b) opens its pages from these.
    expect(t.cached()).toContain(js('scan-a'));
    // Installing b again (the same build) keeps a.
    await t.sw.precacheBuild(true);
    expect(t.cached()).toContain(js('scan-a'));
    Object.assign(t.site, build('c'));
    await t.sw.precacheBuild();
    expect(t.cached().filter((u) => u.endsWith('-a.js'))).toEqual([]);
    expect(t.cached()).toContain(js('scan-b'));
    expect(t.cached()).toContain(js('scan-c'));
  });

  it("drops the pages an earlier build cached, so offline the shell boots this one's", async () => {
    const t = load(build('a'));
    await t.sw.precacheBuild(true);
    const page = (id: string) =>
      `<script src="/web/_expo/static/js/web/__common-${id}.js" defer></script>`;
    await t.cachePage('https://box.test/web/settings', page('a'));
    await t.cachePage('https://box.test/web/reader.html', '<p>reader</p>');
    Object.assign(t.site, build('b'));
    await t.sw.precacheBuild();
    expect(t.cached()).not.toContain('https://box.test/web/settings');
    expect(t.cached()).toContain('https://box.test/web/reader.html');
    await t.cachePage('https://box.test/web/library', page('b'));
    await t.sw.precacheBuild(true);
    expect(t.cached()).toContain('https://box.test/web/library');
  });

  it("precaches the shell's fonts, so an offline cold start draws its text (fe#177)", async () => {
    const font = (id: string) => `https://box.test/web/assets/fonts/Figtree_400.${id}.ttf`;
    const withFont = (id: string) => {
      const site = build(id);
      site[SCOPE] +=
        `<link rel="preload" href="/web/assets/fonts/Figtree_400.${id}.ttf" as="font" crossorigin="">
        <style>@font-face{font-family:"Figtree";src:url("/web/assets/fonts/Figtree_400.${id}.ttf")}
        @font-face{font-family:"Other";src:url("//cdn.test/other.woff2")}</style>`;
      return { ...site, [font(id)]: 'font-bytes' };
    };
    const t = load(withFont('a'));
    await t.sw.precacheBuild(true);
    expect(t.cached()).toContain(font('a'));
    expect(t.fetched).not.toContain('https://cdn.test/other.woff2');
    t.offline.add(font('a'));
    const served = await t.sw.staleWhileRevalidate(new Request(font('a')));
    expect(await served.text()).toBe('font-bytes');
    // A font two builds old goes, like the build's chunks.
    Object.assign(t.site, withFont('b'));
    await t.sw.precacheBuild();
    Object.assign(t.site, withFont('c'));
    await t.sw.precacheBuild();
    expect(t.cached()).not.toContain(font('a'));
    expect(t.cached()).toContain(font('b'));
    expect(t.cached()).toContain(font('c'));
  });

  it('serves a precached font offline to the page, though the server varies it by Origin (fe#177)', async () => {
    const font = 'https://box.test/web/assets/fonts/Figtree_400.v1.ttf';
    const site = build('a');
    site[SCOPE] += `<link rel="preload" href="/web/assets/fonts/Figtree_400.v1.ttf" as="font">`;
    const t = load({ ...site, [font]: 'font-bytes' }, { [font]: { Vary: 'Origin' } });
    await t.sw.precacheBuild(true);
    t.offline.add(font);
    // Cached under the worker's request, which has no Origin; the page's font request has one.
    const page = (destination: string): FetchedAs => ({
      url: font,
      destination,
      headers: new Headers({ Origin: 'https://box.test' }),
    });
    const served = await t.sw.staleWhileRevalidate(page('font'));
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('font-bytes');
    // Anything else keeps to Vary: an Origin-varied answer is never served to another origin.
    expect((await t.sw.staleWhileRevalidate(page('image'))).status).toBe(504);
  });

  it('never fetches again at the precache a font the page cached under its own request (fe#177)', async () => {
    const font = 'https://box.test/web/assets/fonts/Figtree_400.p1.ttf';
    const site = build('a');
    site[SCOPE] += `<link rel="preload" href="/web/assets/fonts/Figtree_400.p1.ttf" as="font">`;
    const t = load({ ...site, [font]: 'font-bytes' }, { [font]: { Vary: 'Origin' } });
    // The page drew its text in it before the worker's precache ran.
    await t.sw.staleWhileRevalidate({
      url: font,
      destination: 'font',
      headers: new Headers({ Origin: 'https://box.test' }),
    });
    t.fetched.length = 0;
    await t.sw.precacheBuild(true);
    expect(t.fetched).not.toContain(font);
    expect(t.cached()).toContain(font);
  });

  it('keeps a cached font at the next install, never fetching it again', async () => {
    const font = 'https://box.test/web/assets/fonts/Figtree_400.f1.ttf';
    const site = build('a');
    site[SCOPE] += `<link rel="preload" href="/web/assets/fonts/Figtree_400.f1.ttf" as="font">`;
    const t = load({ ...site, [font]: 'font-bytes' });
    await t.sw.precacheBuild(true);
    // The next install (each deploy's) writes the scripts again, not the font: a fetch of it
    // that failed then would have dropped the copy the last build cached.
    t.fetched.length = 0;
    t.offline.add(font);
    await t.sw.precacheBuild(true);
    expect(t.fetched).not.toContain(font);
    expect(t.fetched).toContain(js('index-a'));
    expect(t.cached()).toContain(font);
  });

  it('caches the shell for offline when a font of it is refused, the font left out', async () => {
    const site = build('a');
    site[SCOPE] += `<link rel="preload" href="/web/assets/fonts/Missing.ttf" as="font">`;
    const t = load(site);
    await t.sw.precacheBuild(true);
    expect(t.cached()).toContain(SCOPE);
    expect(t.cached()).toContain(`${SCOPE}__precached-build`);
    expect(t.cached()).not.toContain('https://box.test/web/assets/fonts/Missing.ttf');
  });

  it('caches the shell only once its own files are in', async () => {
    const t = load(build('a'));
    t.offline.add(js('index-a'));
    await t.sw.precacheBuild(true);
    expect(t.cached()).not.toContain(SCOPE);
  });

  it('stops when the network goes part way, and finishes on the next ask', async () => {
    const t = load(build('a'));
    t.offline.add(js('scan-a'));
    await t.sw.precacheBuild(true);
    expect(t.cached()).not.toContain(`${SCOPE}__precached-build`);
    expect(t.cached()).not.toContain(js('zxing-a'));
    t.offline.clear();
    await t.sw.precacheBuild();
    expect(t.cached()).toContain(js('zxing-a'));
    expect(t.cached()).toContain(`${SCOPE}__precached-build`);
  });

  it('leaves the cache as it was when the shell cannot be reached', async () => {
    const t = load(build('a'));
    t.offline.add(SCOPE);
    await t.sw.precacheBuild(true);
    expect(t.cached()).toEqual([]);
  });
});

describe('service worker: cacheFirst', () => {
  it('serves a cached build file without the network, and caches one it fetches', async () => {
    const t = load(build('a'));
    const first = await t.sw.cacheFirst(new Request(js('book-a')));
    expect(await first.text()).toBe('__d(function(){})');
    expect(t.cached()).toContain(js('book-a'));
    t.fetched.length = 0;
    await t.sw.cacheFirst(new Request(js('book-a')));
    expect(t.fetched).toEqual([]);
  });
});
