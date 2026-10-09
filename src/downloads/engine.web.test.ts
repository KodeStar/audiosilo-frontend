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

const ORIGIN = 'https://books.example.com';
let engine: DownloadEngine;

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.caches = { open: async () => cache, delete: async () => true };
  g.location = { origin: ORIGIN };
  g.Response = FakeResponse;
  jest.isolateModules(() => {
    engine = (require('./engine.web') as { engine: DownloadEngine }).engine;
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

describe('engine.web moveConnection', () => {
  it("puts every file of the connection under the new id, then drops the old ones", async () => {
    put(at('srv', '1/Book-abc/0.mp3'), 'audio');
    put(at('srv', '1/Book-abc/cover.jpg'), 'cover');
    put(at('srv', '2/Other-1/meta.json'), '{}');
    put(at('srvX', '1/Not-mine/0.mp3'), 'x'); // shares a prefix, not the id
    put(`${ORIGIN}/_offline/__probe__`, '0');
    await engine.moveConnection!('srv', 'srv.3');
    expect([...store.keys()].sort()).toEqual(
      [
        at('srv.3', '1/Book-abc/0.mp3'),
        at('srv.3', '1/Book-abc/cover.jpg'),
        at('srv.3', '2/Other-1/meta.json'),
        at('srvX', '1/Not-mine/0.mp3'),
        `${ORIGIN}/_offline/__probe__`,
      ].sort(),
    );
    expect(store.get(at('srv.3', '1/Book-abc/0.mp3'))).toEqual({
      body: 'audio',
      headers: { 'Content-Length': '5' },
      status: 200,
    });
    // The engine's own url for the new id is where the file now is.
    expect(engine.localUri!('srv.3', 1, 'Book', '0.mp3')).toMatch(`${ORIGIN}/_offline/srv.3/1/`);
  });

  it('a file already at the new url (a run cut short) is kept as it is', async () => {
    put(at('srv', '1/B-1/0.mp3'), 'old');
    put(at('srv.3', '1/B-1/0.mp3'), 'moved');
    await engine.moveConnection!('srv', 'srv.3');
    expect(store.get(at('srv.3', '1/B-1/0.mp3'))?.body).toBe('moved');
    expect(store.has(at('srv', '1/B-1/0.mp3'))).toBe(false);
  });

  it('is a no-op with nothing under the old id', async () => {
    put(at('srv.3', '1/B-1/0.mp3'), 'a');
    await engine.moveConnection!('srv', 'srv.3');
    expect(cache.put).not.toHaveBeenCalled();
    expect([...store.keys()]).toEqual([at('srv.3', '1/B-1/0.mp3')]);
  });

  it('rejects on a file it cannot put, never having dropped one it had not copied; moving back restores', async () => {
    put(at('srv', '1/A-1/0.mp3'), 'a');
    put(at('srv', '1/B-2/0.mp3'), 'b');
    failPut = (url) => url === at('srv.3', '1/B-2/0.mp3');
    await expect(engine.moveConnection!('srv', 'srv.3')).rejects.toThrow(/Quota/);
    expect(store.get(at('srv', '1/B-2/0.mp3'))?.body).toBe('b'); // still where it was
    expect(store.get(at('srv.3', '1/A-1/0.mp3'))?.body).toBe('a'); // the one that moved
    failPut = null;
    await engine.moveConnection!('srv.3', 'srv');
    expect([...store.keys()].sort()).toEqual([at('srv', '1/A-1/0.mp3'), at('srv', '1/B-2/0.mp3')]);
  });
});
