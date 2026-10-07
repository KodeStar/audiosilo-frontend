import { QueryClient } from '@tanstack/react-query';

import type { BookMeta, BookMetaSeries, BookMetaWork, ServerInfo } from '@/api/types';
import type { DownloadEntry } from '@/downloads/types';

// The payload file, kept in memory by (connection, library, path, name).
const mockFiles = new Map<string, string>();
const fileKey = (c: string, l: number, p: string, n: string) => `${c}|${l}|${p}|${n}`;
jest.mock('@/downloads/engine', () => ({
  engine: {
    supported: true,
    writeText: jest.fn(async (c: string, l: number, p: string, n: string, text: string) => {
      mockFiles.set(fileKey(c, l, p, n), text);
      return true;
    }),
    readText: jest.fn(async (c: string, l: number, p: string, n: string) =>
      mockFiles.has(fileKey(c, l, p, n)) ? mockFiles.get(fileKey(c, l, p, n)) : null,
    ),
    removeFile: jest.fn(async (c: string, l: number, p: string, n: string) => {
      mockFiles.delete(fileKey(c, l, p, n));
    }),
  },
}));

// One real query cache (what the screens read), with the app's default 5 min gcTime so
// the "kept for good" rule is observable.
jest.mock('@/api/provider', () => {
  const { QueryClient: QC } = jest.requireActual('@tanstack/react-query');
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});

const mockClient = {
  serverInfo: jest.fn(),
  bookMeta: jest.fn(),
  metaWork: jest.fn(),
};
let mockConnections: string[] = ['c1'];
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => (mockConnections.includes(cid) ? mockClient : null),
  sessionReady: () =>
    jest.requireMock('@/stores/session').useSession.getState().status !== 'loading',
}));
jest.mock('@/stores/session', () => {
  const { create } = jest.requireActual('zustand');
  return {
    ...jest.requireActual('@/stores/session'),
    useSession: create(() => ({ status: 'loading', connections: [] })),
  };
});

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import {
  canMatch,
  captureOfflineMeta,
  newestSnapshots,
  OFFLINE_META_FILE,
  type OfflineMeta,
  parseOfflineMeta,
  readOfflineMeta,
  removeOfflineMeta,
  seedOfflineMeta,
  seedQuery,
  seedServerSnapshot,
  serverHasMetadata,
  whenSessionReady,
  writeOfflineMeta,
} from '@/downloads/offline-meta';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { useSession } from '@/stores/session';
/* eslint-enable import/first */

const qc = queryClient as QueryClient;

function work(id: string, extra: Partial<BookMetaWork> = {}): BookMetaWork {
  return { id, title: id, authors: [], language: 'en', ...extra };
}

const railWork = (id: string, position: string) => ({
  id,
  title: id,
  position,
  authors: [],
  web_url: `https://meta/${id}`,
});

/** The Expanse: this book is 3; 1 and 2 come before it. */
function series(): BookMetaSeries[] {
  return [
    {
      id: 's',
      name: 'The Expanse',
      position: '3',
      works: [railWork('w1', '1'), railWork('w2', '2'), railWork('w3', '3'), railWork('w4', '4')],
    },
  ];
}

function envelope(extra: Partial<Extract<BookMeta, { matched: true }>> = {}): BookMeta {
  return {
    matched: true,
    work: work('w3', { characters: [{ id: 'holden', name: 'Holden' } as never] }),
    series: series(),
    web_url: 'https://meta/w3',
    ...extra,
  };
}

function server(caps: Record<string, boolean>): ServerInfo {
  return {
    name: 'S',
    server_id: 'c1',
    version: '1',
    api: '1',
    capabilities: caps as never,
    auth: { methods: [] },
  };
}

function entry(over: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    connectionId: 'c1',
    libraryId: 2,
    path: 'Corey/Abaddons Gate',
    title: "Abaddon's Gate",
    status: 'downloaded',
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest: {
      book: {
        id: 1,
        library_id: 2,
        rel_path: 'Corey/Abaddons Gate',
        is_folder: true,
        title: "Abaddon's Gate",
        author: 'James S. A. Corey',
        series: 'The Expanse',
        series_index: 3,
        narrator: '',
        duration: 0,
        format: 'mp3',
        size: 0,
        asin: 'B0',
      },
      chapters: null,
      files: [],
      coverUri: null,
      savedAt: '2026-05-01T10:00:00Z',
    },
    ...over,
  };
}

const offline = () => new TypeError('Network request failed');

beforeEach(() => {
  qc.clear();
  mockFiles.clear();
  mockConnections = ['c1'];
  mockClient.serverInfo
    .mockReset()
    .mockResolvedValue(server({ metadata: true, meta_bundle: true }));
  mockClient.bookMeta.mockReset().mockRejectedValue(offline());
  mockClient.metaWork.mockReset().mockRejectedValue(offline());
  useSeriesOrderings.setState({ picks: {} });
});

describe('parseOfflineMeta', () => {
  const valid = {
    v: 1,
    savedAt: 1000,
    previous: true,
    meta: envelope({ previous: [work('w2')] }),
    works: [work('w1')],
    server: { info: server({ metadata: true }), savedAt: 900 },
  };

  it('reads a payload it wrote', () => {
    expect(parseOfflineMeta(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it('reads an unmatched answer', () => {
    expect(parseOfflineMeta({ v: 1, savedAt: 1, meta: { matched: false } })).toEqual({
      v: 1,
      savedAt: 1,
      previous: false,
      meta: { matched: false },
      works: [],
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['another version', { ...valid, v: 2 }],
    ['no time', { ...valid, savedAt: 'yesterday' }],
    ['no envelope', { ...valid, meta: null }],
    ['an envelope without matched', { ...valid, meta: { work: work('w') } }],
    ['a match without its work', { ...valid, meta: { matched: true } }],
  ])('ignores %s', (_label, raw) => {
    expect(parseOfflineMeta(raw)).toBeNull();
  });

  it('drops the parts it cannot use and keeps the rest', () => {
    const parsed = parseOfflineMeta({
      ...valid,
      meta: { ...envelope(), previous: 'w2' },
      works: [work('w1'), { title: 'no id' }, null],
      server: { info: 'S' },
    });
    expect(parsed?.meta).not.toHaveProperty('previous');
    expect(parsed?.works).toEqual([work('w1')]);
    expect(parsed).not.toHaveProperty('server');
  });
});

describe('seedQuery', () => {
  it('seeds a key the cache lacks, dated when it was saved, and keeps it for good', () => {
    seedQuery(['item', 'c1', 2, 'A'], { title: 'A' }, 1234);
    const q = qc.getQueryCache().find({ queryKey: ['item', 'c1', 2, 'A'], exact: true });
    expect(q?.state.data).toEqual({ title: 'A' });
    expect(q?.state.dataUpdatedAt).toBe(1234);
    expect(q?.isStaleByTime(30_000)).toBe(true); // an online screen refetches it
    expect(q?.gcTime).toBe(Infinity);
  });

  it("never covers the server's own answer, but keeps that one for good too", () => {
    qc.setQueryData(['item', 'c1', 2, 'A'], { title: 'fresh' });
    seedQuery(['item', 'c1', 2, 'A'], { title: 'saved' }, 1234);
    const q = qc.getQueryCache().find({ queryKey: ['item', 'c1', 2, 'A'], exact: true });
    expect(q?.state.data).toEqual({ title: 'fresh' });
    expect(q?.gcTime).toBe(Infinity);
  });
});

describe('seedOfflineMeta', () => {
  it('answers the plain request, the include=previous one and every previous work', () => {
    const payload: OfflineMeta = {
      v: 1,
      savedAt: 5000,
      previous: true,
      meta: envelope({ previous: [work('w2')] }),
      works: [work('w1')],
    };
    seedOfflineMeta('c1', 2, 'P', payload);
    const plain = qc.getQueryData<BookMeta>(qk.bookMeta('c1', 2, 'P'));
    expect(plain).toMatchObject({ matched: true, work: { id: 'w3' } });
    expect(plain).not.toHaveProperty('previous'); // the plain answer has none
    expect(qc.getQueryData(qk.bookMeta('c1', 2, 'P', { includePrevious: true }))).toBe(
      payload.meta,
    );
    expect(qc.getQueryData(qk.metaWork('c1', 'w2'))).toEqual(work('w2'));
    expect(qc.getQueryData(qk.metaWork('c1', 'w1'))).toEqual(work('w1'));
    expect(qc.getQueryState(qk.bookMeta('c1', 2, 'P'))?.dataUpdatedAt).toBe(5000);
    // Never the spoilers=hide variant: it is cut at the place it was fetched at.
    expect(qc.getQueryData(qk.bookMeta('c1', 2, 'P', { hideSpoilers: true }))).toBeUndefined();
  });

  it('answers an unmatched book as unmatched, and only the plain request without previous', () => {
    seedOfflineMeta('c1', 2, 'P', {
      v: 1,
      savedAt: 1,
      previous: false,
      meta: { matched: false },
      works: [],
    });
    expect(qc.getQueryData(qk.bookMeta('c1', 2, 'P'))).toEqual({ matched: false });
    expect(qc.getQueryData(qk.bookMeta('c1', 2, 'P', { includePrevious: true }))).toBeUndefined();
  });
});

describe('the /server snapshot', () => {
  it('is seeded only where the cache has no answer', () => {
    seedServerSnapshot('c1', { info: server({ metadata: true }), savedAt: 1 });
    expect(qc.getQueryData<ServerInfo>(qk.server('c1'))?.capabilities.metadata).toBe(true);
    qc.setQueryData(qk.server('c2'), server({ metadata: false }));
    seedServerSnapshot('c2', { info: server({ metadata: true }), savedAt: 1 });
    expect(qc.getQueryData<ServerInfo>(qk.server('c2'))?.capabilities.metadata).toBe(false);
  });

  it('newestSnapshots picks the newest answer per connection', () => {
    const p = (savedAt: number, withServer = true): OfflineMeta => ({
      v: 1,
      savedAt,
      previous: false,
      meta: { matched: false },
      works: [],
      ...(withServer ? { server: { info: server({ v: savedAt > 1 }), savedAt } } : {}),
    });
    const newest = newestSnapshots([
      { connectionId: 'c1', payload: p(1) },
      { connectionId: 'c1', payload: p(3) },
      { connectionId: 'c1', payload: p(2) },
      { connectionId: 'c2', payload: p(9, false) },
    ]);
    expect(newest.get('c1')?.savedAt).toBe(3);
    expect(newest.has('c2')).toBe(false);
  });
});

describe('captureOfflineMeta', () => {
  it('with meta_bundle: one request brings the envelope and the previous works', async () => {
    const meta = envelope({ previous: [work('w2'), work('w1')] });
    mockClient.bookMeta.mockResolvedValue(meta);
    const payload = await captureOfflineMeta(entry());
    expect(mockClient.bookMeta).toHaveBeenCalledTimes(1);
    expect(mockClient.bookMeta.mock.calls[0][3]).toEqual({ includePrevious: true });
    // The nearest earlier book (2) came with it, so nothing more is asked.
    expect(mockClient.metaWork).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ v: 1, previous: true, meta, works: [] });
    expect(payload?.server?.info.capabilities.metadata).toBe(true);
    expect(payload?.savedAt).toBe(
      qc.getQueryState(qk.bookMeta('c1', 2, 'Corey/Abaddons Gate', { includePrevious: true }))
        ?.dataUpdatedAt,
    );
  });

  it('without meta_bundle: the plain envelope, then the nearest earlier work on its own', async () => {
    mockClient.serverInfo.mockResolvedValue(server({ metadata: true }));
    mockClient.bookMeta.mockResolvedValue(envelope());
    mockClient.metaWork.mockResolvedValue(work('w2'));
    const payload = await captureOfflineMeta(entry());
    expect(mockClient.bookMeta.mock.calls[0][3]).toBeUndefined();
    expect(mockClient.metaWork).toHaveBeenCalledTimes(1);
    expect(mockClient.metaWork.mock.calls[0][0]).toBe('w2');
    expect(payload).toMatchObject({ previous: false, works: [work('w2')] });
  });

  it("follows the listener's reading order where the server's previous books don't", async () => {
    // The family's chronological order puts a novella (n1) right before this book.
    const family: BookMetaSeries = {
      ...series()[0],
      orderings: [
        {
          id: 'chrono',
          name: 'The Expanse (chronological)',
          ordering: 'chronological',
          ordering_of: 's',
          position: '5',
          works: [railWork('w2', '3'), railWork('n1', '4'), railWork('w3', '5')],
        },
      ],
    };
    mockClient.bookMeta.mockResolvedValue(envelope({ series: [family], previous: [work('w2')] }));
    mockClient.metaWork.mockResolvedValue(work('n1'));
    useSeriesOrderings.setState({ picks: { s: 'chrono' } });
    const payload = await captureOfflineMeta(entry());
    expect(mockClient.metaWork).toHaveBeenCalledTimes(1);
    expect(mockClient.metaWork.mock.calls[0][0]).toBe('n1');
    expect(payload?.works).toEqual([work('n1')]);
  });

  it('keeps a previous work that could not be read out, and the rest', async () => {
    mockClient.serverInfo.mockResolvedValue(server({ metadata: true }));
    mockClient.bookMeta.mockResolvedValue(envelope());
    const payload = await captureOfflineMeta(entry());
    expect(payload).toMatchObject({ meta: { matched: true }, works: [] });
  });

  it('keeps an unmatched answer too', async () => {
    mockClient.bookMeta.mockResolvedValue({ matched: false });
    await expect(captureOfflineMeta(entry())).resolves.toMatchObject({
      meta: { matched: false },
      works: [],
    });
  });

  it('asks nothing for a book without an ASIN or ISBN', async () => {
    const e = entry();
    delete e.manifest.book.asin;
    expect(canMatch(e)).toBe(false);
    await expect(captureOfflineMeta(e)).resolves.toBeNull();
    expect(mockClient.serverInfo).not.toHaveBeenCalled();
  });

  it("reads a list-shape book's ids from its full item", () => {
    const e = entry();
    delete e.manifest.book.asin;
    qc.setQueryData(qk.item('c1', 2, e.path), { ...e.manifest.book, isbn: '978' });
    expect(canMatch(e)).toBe(true);
  });

  it('asks a server without metadata for nothing more', async () => {
    mockClient.serverInfo.mockResolvedValue(server({ meta_bundle: true }));
    await expect(captureOfflineMeta(entry())).resolves.toBeNull();
    expect(mockClient.bookMeta).not.toHaveBeenCalled();
    await expect(serverHasMetadata('c1')).resolves.toBe(false);
  });

  it('is nothing, never an error, when the server cannot be reached or is gone', async () => {
    mockClient.serverInfo.mockRejectedValue(offline());
    await expect(captureOfflineMeta(entry())).resolves.toBeNull();
    await expect(serverHasMetadata('c1')).resolves.toBe(false);
    mockClient.serverInfo.mockResolvedValue(server({ metadata: true }));
    await expect(captureOfflineMeta(entry())).resolves.toBeNull(); // /meta itself fails
    mockConnections = [];
    await expect(captureOfflineMeta(entry())).resolves.toBeNull();
    await expect(serverHasMetadata('c1')).resolves.toBe(false);
  });
});

describe('the payload file', () => {
  const payload: OfflineMeta = {
    v: 1,
    savedAt: 7,
    previous: false,
    meta: { matched: false },
    works: [],
  };

  it('round-trips beside the book, and goes when removed', async () => {
    const e = entry();
    await expect(writeOfflineMeta(e, payload)).resolves.toBe(true);
    expect(mockFiles.has(fileKey('c1', 2, e.path, OFFLINE_META_FILE))).toBe(true);
    await expect(readOfflineMeta(e)).resolves.toEqual(payload);
    await removeOfflineMeta(e);
    await expect(readOfflineMeta(e)).resolves.toBeNull();
  });

  it('reads a corrupt file as none', async () => {
    const e = entry();
    mockFiles.set(fileKey('c1', 2, e.path, OFFLINE_META_FILE), '{"v":1,');
    await expect(readOfflineMeta(e)).resolves.toBeNull();
    mockFiles.set(fileKey('c1', 2, e.path, OFFLINE_META_FILE), '{"v":9}');
    await expect(readOfflineMeta(e)).resolves.toBeNull();
  });
});

describe('whenSessionReady', () => {
  it('waits for the session to hydrate', async () => {
    let ready = false;
    const waiting = whenSessionReady().then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);
    (useSession as unknown as { setState: (s: object) => void }).setState({
      status: 'authenticated',
    });
    await waiting;
    expect(ready).toBe(true);
    await expect(whenSessionReady()).resolves.toBeUndefined();
  });
});
