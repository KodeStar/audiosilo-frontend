import type { DownloadEngine } from './types';

// A Cache API stand-in: one cache of url -> { body, headers }. `put` stores the body it is
// handed (the engine streams one cached body into the new entry); `failPut` makes a put
// reject (the quota).
type Stored = { body: string; headers: Record<string, string>; status: number };
const store = new Map<string, Stored>();
let failPut: ((url: string) => boolean) | null = null;
const urlOf = (r: string | { url: string }) => (typeof r === 'string' ? r : r.url);

class FakeResponse {
  body: string;
  status: number;
  statusText = '';
  headers: Record<string, string>;
  constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
    this.body = body as string;
    this.status = init.status ?? 200;
    this.headers = { ...(init.headers ?? {}) };
  }
  async text() {
    return this.body;
  }
  async arrayBuffer() {
    return new TextEncoder().encode(this.body).buffer;
  }
}

const cache = {
  keys: jest.fn(async () => [...store.keys()].map((url) => ({ url }))),
  match: jest.fn(async (r: string | { url: string }) => {
    const s = store.get(urlOf(r));
    return s ? new FakeResponse(s.body, { status: s.status, headers: s.headers }) : undefined;
  }),
  put: jest.fn(async (r: string | { url: string }, res: FakeResponse) => {
    if (failPut?.(urlOf(r))) throw new Error('QuotaExceededError');
    store.set(urlOf(r), { body: res.body, headers: res.headers, status: res.status });
  }),
  delete: jest.fn(async (r: string | { url: string }) => store.delete(urlOf(r))),
};

// The network, answering like the server's ebook route: it takes the Authorization header
// only (never `?token=`), so a request without it is refused.
const fetchMock = jest.fn(async (_url: string, init?: RequestInit) =>
  (init?.headers as Record<string, string> | undefined)?.Authorization === 'Bearer t'
    ? {
        ok: true,
        status: 200,
        body: new ReadableStream(),
        headers: new Headers({ 'Content-Length': '4' }),
      }
    : { ok: false, status: 401, body: null },
);

const ORIGIN = 'https://books.example.com';
let engine: DownloadEngine;
// The engine's own copy of the alias table (it is loaded in isolation below).
let setConnectionAliases: (next: Record<string, string>) => void;

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.caches = { open: async () => cache, delete: async () => true };
  g.location = { origin: ORIGIN };
  g.Response = FakeResponse;
  g.fetch = fetchMock;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    engine = (require('./engine.web') as { engine: DownloadEngine }).engine;
    ({ setConnectionAliases } =
      require('@/lib/connection-id') as typeof import('@/lib/connection-id'));
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
});

beforeEach(() => {
  store.clear();
  failPut = null;
  jest.clearAllMocks();
});

const at = (id: string, rest: string) => `${ORIGIN}/_offline/${id}/${rest}`;
const put = (url: string, body: string) =>
  store.set(url, { body, headers: { 'Content-Length': String(body.length) }, status: 200 });

describe('engine.web, a connection the identity migration moved', () => {
  afterEach(() => setConnectionAliases({}));

  it('moves no file: the web has no moveConnection (the launch never copies)', () => {
    expect(engine.moveConnection).toBeUndefined();
  });

  it("finds, writes and removes the moved connection's files under its legacy id", async () => {
    // Where the files were downloaded, before the migration.
    const audio = engine.localUri!('srv', 1, 'Book', '0.mp3');
    expect(audio).toMatch(`${ORIGIN}/_offline/srv/1/`);
    put(audio, 'audio');
    put(at('srvX', '1/Book-abc/0.mp3'), 'x'); // shares a prefix, not the id
    setConnectionAliases({ srv: 'srv.3' });

    // The registry's new id reads the file where it always was.
    expect(engine.localUri!('srv.3', 1, 'Book', '0.mp3')).toBe(audio);
    expect(await engine.fileExists(engine.localUri!('srv.3', 1, 'Book', '0.mp3'))).toBe(true);
    expect(await engine.writeText!('srv.3', 1, 'Book', 'meta.json', '{}')).toBe(true);
    expect(store.has(engine.localUri!('srv', 1, 'Book', 'meta.json'))).toBe(true);
    expect([...store.keys()].some((k) => k.includes('/_offline/srv.3/'))).toBe(false);

    await engine.removeBook('srv.3', 1, 'Book');
    expect([...store.keys()]).toEqual([at('srvX', '1/Book-abc/0.mp3')]);
  });

  it('a connection nobody moved (a new one, or one still legacy) uses its own id', () => {
    setConnectionAliases({ srv: 'srv.3' });
    expect(engine.localUri!('other.2', 1, 'Book', '0.mp3')).toMatch(
      `${ORIGIN}/_offline/other.2/1/`,
    );
    expect(engine.localUri!('srv', 1, 'Book', '0.mp3')).toMatch(`${ORIGIN}/_offline/srv/1/`);
  });
});

describe('engine.web downloadFile', () => {
  it('sends the request headers with the fetch (the ebook route takes no ?token=)', async () => {
    const signal = new AbortController().signal;
    const uri = await engine.downloadFile(
      'srv',
      1,
      'A/Book',
      'book.epub',
      'https://h/ebook',
      undefined,
      signal,
      { Authorization: 'Bearer t' },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://h/ebook',
      expect.objectContaining({ signal, headers: { Authorization: 'Bearer t' } }),
    );
    // Saved under the uri the store keeps (and relocates to), which readFile reads.
    expect(uri).toBe(engine.localUri!('srv', 1, 'A/Book', 'book.epub'));
    expect(store.has(uri)).toBe(true);
  });
});

describe('engine.web readFile', () => {
  const epub = () => engine.localUri!('srv', 1, 'A/Book', 'book.epub');

  it("reads a stored file's bytes straight from the cache", async () => {
    put(epub(), 'EPUB');
    const bytes = await engine.readFile!(epub());
    expect(new TextDecoder().decode(bytes!)).toBe('EPUB');
    expect(cache.match).toHaveBeenCalledWith(epub());
  });

  it('resolves null for a file the cache does not hold', async () => {
    put(engine.localUri!('srv', 1, 'A/Book', '0.mp3'), 'audio');
    await expect(engine.readFile!(epub())).resolves.toBeNull();
  });

  it('resolves null when the cache cannot be read (the reader then fetches)', async () => {
    put(epub(), 'EPUB');
    cache.match.mockRejectedValueOnce(new Error('SecurityError'));
    await expect(engine.readFile!(epub())).resolves.toBeNull();
  });
});
