import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { STARTUP_CACHE_KEY } from '@/lib/storage-keys';

// The web: a page with localStorage (jest runs the native platform otherwise).
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));

/* eslint-disable import/first */
import {
  forget,
  isStartupQuery,
  restore,
  SAVE_DELAY_MS,
  save,
  snapshot,
  startSaving,
} from './startup-cache';
/* eslint-enable import/first */

/** An in-memory localStorage, with the page's events for `startSaving`. */
const items = new Map<string, string>();
const listeners = new Map<string, () => void>();
const page = {
  localStorage: {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  },
  addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
  removeEventListener: (t: string) => listeners.delete(t),
};
const doc = { visibilityState: 'visible', ...page };
const realWindow = globalThis.window;
const realDocument = globalThis.document;
beforeAll(() => {
  Object.assign(globalThis, { window: page, document: doc });
});
afterAll(() => {
  Object.assign(globalThis, { window: realWindow, document: realDocument });
});
beforeEach(() => {
  items.clear();
  listeners.clear();
});

const C = 'srv.1';
const book = (title: string) => ({ title, rel_path: title });
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const stored = () => JSON.parse(items.get(STARTUP_CACHE_KEY) ?? 'null');

describe('isStartupQuery', () => {
  it('keeps what the first screens paint from', () => {
    for (const key of [
      ['server', C],
      ['libraries', C],
      ['books', 'recent', C, 48],
      ['progress', 'all', C],
      ['favourites', C],
      ['myStats', C, '30d'],
      ['libraryBooks', C, 1, { sort: 'recent' }, { pageSize: 200 }],
    ]) {
      expect([key, isStartupQuery(key)]).toEqual([key, true]);
    }
  });

  it('keeps nothing else: a narrowed list, a book, a book’s progress', () => {
    for (const key of [
      ['libraryBooks', C, 1, { sort: 'recent', author: 'Austen' }],
      ['libraryBooks', C, 1, { series: 'Dune' }],
      ['item', C, 1, 'a/b'],
      ['progress', C, 1, 'a/b'],
      ['search', C, 'dune'],
      [42],
    ]) {
      expect([key, isStartupQuery(key)]).toEqual([key, false]);
    }
  });
});

describe('snapshot and restore', () => {
  it('keeps the startup answers, an infinite list only its first page', () => {
    const qc = newClient();
    qc.setQueryData(['server', C], { server_id: 'srv' });
    qc.setQueryData(['item', C, 1, 'a'], { title: 'not kept' });
    qc.setQueryData(['libraryBooks', C, 1, { sort: 'recent' }, { pageSize: 200 }], {
      pages: [{ books: [book('A')], next_cursor: 'p2' }, { books: [book('B')] }],
      pageParams: [undefined, 'p2'],
    });
    const entries = snapshot(qc);
    expect(entries.map((e) => e.key[0]).sort()).toEqual(['libraryBooks', 'server']);
    const list = entries.find((e) => e.key[0] === 'libraryBooks');
    expect(list).toMatchObject({
      data: { books: [book('A')], next_cursor: 'p2' },
      firstPage: true,
    });
  });

  it('puts the kept answers back, each to be asked for again on mount', async () => {
    const before = newClient();
    before.setQueryData(['server', C], { server_id: 'srv' });
    const listKey = ['libraryBooks', C, 1, { sort: 'recent' }, { pageSize: 200 }];
    before.setQueryData(listKey, {
      pages: [{ books: [book('A')], next_cursor: 'p2' }, { books: [book('B')] }],
      pageParams: [undefined, 'p2'],
    });
    save(before);

    const qc = newClient();
    expect(restore(qc)).toBe(2);
    expect(qc.getQueryData(['server', C])).toEqual({ server_id: 'srv' });
    // The list restarts from its first page, whose param is `undefined` again.
    expect(qc.getQueryData(listKey)).toEqual({
      pages: [{ books: [book('A')], next_cursor: 'p2' }],
      pageParams: [undefined],
    });
    expect(qc.getQueryState(['server', C])?.isInvalidated).toBe(true);

    // A hook mounting on it shows the kept answer and asks the server again.
    const queryFn = jest.fn(async () => ({ server_id: 'srv', version: 'new' }));
    const observer = new QueryObserver(qc, { queryKey: ['server', C], queryFn, staleTime: 60_000 });
    expect(observer.getCurrentResult().data).toEqual({ server_id: 'srv' });
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(['server', C])).toEqual({ server_id: 'srv', version: 'new' });
    unsubscribe();
  });

  it('never replaces a query already in the cache', () => {
    const before = newClient();
    before.setQueryData(['libraries', C], [{ id: 1, name: 'old' }]);
    save(before);
    const qc = newClient();
    qc.setQueryData(['libraries', C], [{ id: 1, name: 'live' }]);
    expect(restore(qc)).toBe(0);
    expect(qc.getQueryData(['libraries', C])).toEqual([{ id: 1, name: 'live' }]);
  });

  it('ignores a document of another version, an unreadable one and foreign entries', () => {
    items.set(STARTUP_CACHE_KEY, JSON.stringify({ v: 99, entries: [] }));
    expect(restore(newClient())).toBe(0);
    items.set(STARTUP_CACHE_KEY, '{not json');
    expect(restore(newClient())).toBe(0);
    items.set(
      STARTUP_CACHE_KEY,
      JSON.stringify({
        v: 1,
        entries: [
          { key: ['item', C, 1, 'a'], data: {}, updatedAt: 1 },
          { key: ['server', C], updatedAt: 1 },
          { key: ['libraries', C], data: [], updatedAt: 1 },
        ],
      }),
    );
    const qc = newClient();
    expect(restore(qc)).toBe(1);
    expect(qc.getQueryData(['libraries', C])).toEqual([]);
  });

  it('writes nothing over the size limit (and drops the old document)', () => {
    const qc = newClient();
    qc.setQueryData(['libraries', C], [{ name: 'x'.repeat(1_600_000) }]);
    items.set(STARTUP_CACHE_KEY, 'old');
    save(qc);
    expect(items.has(STARTUP_CACHE_KEY)).toBe(false);
  });
});

describe('forget', () => {
  it('drops a signed-out connection’s answers and keeps the others', () => {
    const qc = newClient();
    qc.setQueryData(['libraries', C], [{ id: 1 }]);
    qc.setQueryData(['libraries', 'other.2'], [{ id: 2 }]);
    save(qc);
    forget(C);
    expect(stored().entries.map((e: { key: unknown[] }) => e.key)).toEqual([
      ['libraries', 'other.2'],
    ]);
  });
});

describe('startSaving', () => {
  afterEach(() => jest.useRealTimers());

  it('writes a while after a startup answer, and at once when the page is hidden', async () => {
    jest.useFakeTimers();
    const qc = newClient();
    const stop = startSaving(qc);
    await qc.fetchQuery({ queryKey: ['libraries', C], queryFn: async () => [{ id: 1 }] });
    expect(items.has(STARTUP_CACHE_KEY)).toBe(false);
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(stored().entries).toHaveLength(1);

    // Another answer, then the page goes away before the delay is up.
    await qc.fetchQuery({ queryKey: ['server', C], queryFn: async () => ({ server_id: 'srv' }) });
    listeners.get('pagehide')?.();
    expect(stored().entries).toHaveLength(2);

    // A query the cache does not keep schedules nothing.
    items.clear();
    await qc.fetchQuery({ queryKey: ['item', C, 1, 'a'], queryFn: async () => ({}) });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(items.has(STARTUP_CACHE_KEY)).toBe(false);

    stop();
    expect(listeners.size).toBe(0);
  });
});
