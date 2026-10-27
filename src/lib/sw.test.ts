import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The hand-written service worker (`public/sw.js`), run against fake worker globals: its
 * install precache, and the navigation branch that keeps the app shell out of the ebook
 * reader's frame (fe#164) while answering that frame from the cache offline (PLAYER-01).
 */

const SCOPE = 'https://h/web/';
const READER = `${SCOPE}reader.html`;
const SHELL = 'audiosilo-shell-v1';

type Handler = (event: unknown) => void;
type FakeRequest = { url: string; method: string; mode: string; destination: string };

/** A fake Response: just what the worker and these tests read. */
class FakeResponse {
  constructor(
    public body: string,
    public init: { status?: number } = {},
  ) {}
  get ok() {
    return (this.init.status ?? 200) < 400;
  }
  get status() {
    return this.init.status ?? 200;
  }
  clone() {
    return new FakeResponse(this.body, this.init);
  }
}

/** A worker with its caches and a network that is up (`online`) or down; `served` is what
 * the server answers per url (a 404 for anything else). */
function worker({ online = true, served = {} as Record<string, string> } = {}) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, FakeResponse>>();
  const net = { online };
  const urlOf = (r: string | { url: string }) => (typeof r === 'string' ? r : r.url);
  const fetch = jest.fn(async (r: string | { url: string }) => {
    if (!net.online) throw new TypeError('Failed to fetch');
    const url = urlOf(r);
    return url in served
      ? new FakeResponse(served[url])
      : new FakeResponse('nope', { status: 404 });
  });
  const open = async (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    const s = store;
    return {
      match: async (r: string | { url: string }) => s.get(urlOf(r)),
      put: async (r: string | { url: string }, res: FakeResponse) => void s.set(urlOf(r), res),
      add: async (r: string | { url: string }) => {
        const res = await fetch(r);
        if (!res.ok) throw new TypeError(`bad response ${res.status}`);
        s.set(urlOf(r), res);
      },
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const self = {
    location: { href: `${SCOPE}sw.js`, origin: 'https://h' },
    registration: { scope: SCOPE },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  class FakeRequestCtor {
    constructor(
      public url: string,
      public init: unknown = {},
    ) {}
  }
  const source = readFileSync(join(__dirname, '../../public/sw.js'), 'utf8');
  new Function('self', 'caches', 'fetch', 'Response', 'Request', source)(
    self,
    caches,
    fetch,
    FakeResponse,
    FakeRequestCtor,
  );

  /** Runs an extendable event's handler and waits for what it extended. */
  const dispatch = async (type: string, extra: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let response: Promise<FakeResponse> | undefined;
    handlers.get(type)!({
      ...extra,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<FakeResponse>) => (response = p),
    });
    await Promise.all(waits);
    return response ? await response : undefined;
  };
  const navigate = (url: string, destination = 'document') =>
    dispatch('fetch', {
      request: { url, method: 'GET', mode: 'navigate', destination } satisfies FakeRequest,
    });
  const cached = (url: string) => stores.get(SHELL)?.get(url)?.body;
  return { dispatch, navigate, cached, net, fetch };
}

const SITE = { [SCOPE]: '<shell>', [READER]: '<reader>' };

describe('sw.js', () => {
  it('precaches the app shell and the reader document on install (PLAYER-01)', async () => {
    const sw = worker({ served: SITE });
    await sw.dispatch('install');
    expect(sw.cached(SCOPE)).toBe('<shell>');
    expect(sw.cached(READER)).toBe('<reader>');
  });

  it('opens the reader offline from the precache, though it never opened online', async () => {
    const sw = worker({ served: SITE });
    await sw.dispatch('install');
    sw.net.online = false;
    const res = await sw.navigate(READER, 'iframe');
    expect(res?.body).toBe('<reader>');
  });

  it('still installs with the shell when the server has no reader (an older server)', async () => {
    const sw = worker({ served: { [SCOPE]: '<shell>' } });
    await sw.dispatch('install');
    expect(sw.cached(SCOPE)).toBe('<shell>');
    expect(sw.cached(READER)).toBeUndefined();
  });

  it('never answers the reader document with the app shell, offline included (fe#164)', async () => {
    const sw = worker({ served: { [SCOPE]: '<shell>' } });
    await sw.dispatch('install');
    sw.net.online = false;
    const res = await sw.navigate(READER, 'iframe');
    expect(res?.status).toBe(503);
    expect(res?.body).toBe('Offline');
  });

  it('serves the reader fresh online, keeping that copy for offline', async () => {
    const sw = worker({ served: SITE });
    await sw.dispatch('install');
    const res = await sw.navigate(READER, 'iframe');
    expect(res?.body).toBe('<reader>');
    expect(sw.fetch).toHaveBeenLastCalledWith(expect.objectContaining({ url: READER }));
  });

  it('answers any other offline navigation with the app shell', async () => {
    const sw = worker({ served: SITE });
    await sw.dispatch('install');
    sw.net.online = false;
    const res = await sw.navigate(`${SCOPE}library`);
    expect(res?.body).toBe('<shell>');
  });
});
