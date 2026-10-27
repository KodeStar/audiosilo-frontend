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

type Store = Map<string, { body: string; type: string }>;

function makeCaches() {
  const caches = new Map<string, Store>();
  const urlOf = (r: string | { url: string }) => (typeof r === 'string' ? r : r.url);
  const open = async (name: string) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const store = caches.get(name)!;
    return {
      match: async (r: string | { url: string }) => {
        const hit = store.get(urlOf(r));
        return hit ? new Response(hit.body) : undefined;
      },
      put: async (r: string | { url: string }, res: Response) => {
        store.set(urlOf(r), { body: await res.text(), type: 'basic' });
      },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (r: { url: string }) => store.delete(r.url),
    };
  };
  return { api: { open, keys: async () => [...caches.keys()] }, caches };
}

function load(site: Record<string, string>) {
  const fetched: string[] = [];
  const offline = new Set<string>();
  const fetch = jest.fn(async (r: string | Request) => {
    const url = typeof r === 'string' ? r : r.url;
    fetched.push(url);
    if (offline.has(url)) throw new TypeError('offline');
    const body = site[url];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
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
  };
  const cached = () => [...(caches.get('audiosilo-shell-v1') ?? new Map()).keys()].sort();
  return { sw, fetched, offline, cached, site };
}

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

  it("takes a new build's chunks and drops the old build's", async () => {
    const t = load(build('a'));
    await t.sw.precacheBuild(true);
    Object.assign(t.site, build('b'));
    await t.sw.precacheBuild();
    expect(t.cached()).toContain(js('zxing-b'));
    expect(t.cached().filter((u) => u.endsWith('-a.js'))).toEqual([]);
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
