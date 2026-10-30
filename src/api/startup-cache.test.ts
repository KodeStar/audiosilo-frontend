import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { STARTUP_CACHE_KEY } from '@/lib/storage-keys';

// The web: a page with localStorage (jest runs the native platform otherwise).
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('@/lib/version', () => ({ APP_VERSION: '9.9.9' }));

/* eslint-disable import/first */
import {
  forget,
  PROGRESS_BOOKS,
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
      ['myListening', C, '1y'],
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
      ['myStats', C, '2023'],
      ['myListening', C, '30d'],
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
    restore(qc);
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
    restore(qc);
    expect(qc.getQueryData(['libraries', C])).toEqual([{ id: 1, name: 'live' }]);
    expect(qc.getQueryState(['libraries', C])?.isInvalidated).toBe(false);
  });

  it('ignores a document of another version, an unreadable one and foreign entries', () => {
    const restored = () => {
      const qc = newClient();
      restore(qc);
      return qc.getQueryCache().getAll().length;
    };
    items.set(
      STARTUP_CACHE_KEY,
      JSON.stringify({
        v: 99,
        app: '9.9.9',
        entries: [{ key: ['libraries', C], data: [], updatedAt: 1 }],
      }),
    );
    expect(restored()).toBe(0);
    // Another app version's answers may have another shape.
    items.set(
      STARTUP_CACHE_KEY,
      JSON.stringify({
        v: 1,
        app: '9.9.8',
        entries: [{ key: ['libraries', C], data: [], updatedAt: 1 }],
      }),
    );
    expect(restored()).toBe(0);
    items.set(STARTUP_CACHE_KEY, '{not json');
    expect(restored()).toBe(0);
    items.set(
      STARTUP_CACHE_KEY,
      JSON.stringify({
        v: 1,
        app: '9.9.9',
        entries: [
          { key: ['item', C, 1, 'a'], data: {}, updatedAt: 1 },
          { key: ['server', C], updatedAt: 1 },
          // The whole-library list is only ever kept as its first page.
          { key: ['libraryBooks', C, 1, { sort: 'recent' }], data: { books: [] }, updatedAt: 1 },
          { key: ['libraries', C], data: [], updatedAt: 1 },
        ],
      }),
    );
    const qc = newClient();
    restore(qc);
    expect(
      qc
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    ).toEqual([['libraries', C]]);
    expect(qc.getQueryData(['libraries', C])).toEqual([]);
  });

  it('keeps each answer while the document stays under the size limit', () => {
    const qc = newClient();
    qc.setQueryData(['server', C], { server_id: 'srv' });
    qc.setQueryData(['libraries', C], [{ name: 'x'.repeat(600_000) }]);
    qc.setQueryData(['queue', C], []);
    items.set(STARTUP_CACHE_KEY, 'old');
    save(qc);
    expect(stored().entries.map((e: { key: unknown[] }) => e.key)).toEqual([
      ['server', C],
      ['queue', C],
    ]);
  });

  it('writes only the answers `keep` takes, a failed ask’s last answer included', async () => {
    const qc = newClient();
    qc.setQueryData(['libraries', C], [{ id: 1 }]);
    qc.setQueryData(['libraries', 'gone.2'], [{ id: 2 }]);
    await qc
      .fetchQuery({
        queryKey: ['libraries', C],
        queryFn: async () => {
          throw new Error('down');
        },
      })
      .catch(() => undefined);
    save(qc, (key) => key.includes(C));
    expect(stored().entries).toEqual([
      expect.objectContaining({ key: ['libraries', C], data: [{ id: 1 }] }),
    ]);
  });

  it('asks again for a kept answer whose first reader reads the cache as is', async () => {
    const before = newClient();
    before.setQueryData(['progress', 'all', C], [{ path: 'a', finished: false }]);
    save(before);
    const qc = newClient();
    restore(qc);
    const queryFn = jest.fn(async () => [{ path: 'a', finished: true }]);
    const observer = new QueryObserver(qc, {
      queryKey: ['progress', 'all', C],
      queryFn,
      refetchOnMount: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(['progress', 'all', C])).toEqual([{ path: 'a', finished: true }]);
    // Once asked, another reader reads the cache as is again.
    const second = new QueryObserver(qc, {
      queryKey: ['progress', 'all', C],
      queryFn,
      refetchOnMount: false,
    });
    const unsubscribeSecond = second.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribeSecond();
  });

  it('clears a kept answer whose server refuses the token', async () => {
    const before = newClient();
    before.setQueryData(['progress', 'all', C], [{ path: 'a' }]);
    save(before);
    const qc = newClient();
    const refused = new Error('401');
    restore(qc, { dropOnError: (e) => e === refused });
    const queryFn = jest.fn(async () => {
      throw refused;
    });
    const observer = new QueryObserver(qc, { queryKey: ['progress', 'all', C], queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(qc.getQueryData(['progress', 'all', C])).toBeUndefined();
    expect(qc.getQueryState(['progress', 'all', C])?.status).toBe('error');
    unsubscribe();
  });
});

// v2.5.1 PLAYER-02: a reload offline still titles the progress rows (Home, Up next), whose
// books no kept list may name.
describe('progress-row books', () => {
  const row = (path: string, updated_at: string, finished = false) => ({
    library_id: 1,
    path,
    position: 10,
    duration: 100,
    finished,
    updated_at,
  });
  const item = (path: string, title: string) => ({
    library_id: 1,
    rel_path: path,
    title,
    author: 'James S. A. Corey',
    cover_version: 'v1',
    description: 'not kept',
    files: [{ path: `${path}/01.mp3` }],
  });
  const keptBooks = () =>
    stored().entries.find((e: { key: unknown[] }) => e.key[0] === PROGRESS_BOOKS);

  it("keeps each progress row's title as its /item named it, newest save first", () => {
    const qc = newClient();
    qc.setQueryData(
      ['progress', 'all', C],
      [row('a/1', '2026-10-01'), row('a/2', '2026-10-03'), row('a/3', '2026-10-02', true)],
    );
    qc.setQueryData(['item', C, 1, 'a/1'], item('a/1', 'Leviathan Wakes'));
    qc.setQueryData(['item', C, 1, 'a/2'], item('a/2', "Caliban's War"));
    qc.setQueryData(['item', C, 1, 'a/3'], item('a/3', 'Finished'));
    save(qc);
    expect(keptBooks()).toMatchObject({
      key: [PROGRESS_BOOKS, C],
      data: [
        {
          library_id: 1,
          rel_path: 'a/2',
          title: "Caliban's War",
          author: 'James S. A. Corey',
          cover_version: 'v1',
        },
        { rel_path: 'a/1', title: 'Leviathan Wakes' },
        // Finished after the unfinished ones: Home's Recently finished.
        { rel_path: 'a/3', title: 'Finished' },
      ],
    });
    // Only what a row draws: no description, no files.
    expect(keptBooks().data[0]).not.toHaveProperty('description');
    expect(keptBooks().data[0]).not.toHaveProperty('files');
  });

  it('keeps no book Home would not show: unfinished and never started', () => {
    const qc = newClient();
    qc.setQueryData(
      ['progress', 'all', C],
      [row('a/1', '2026-10-01'), { ...row('a/0', '2026-10-02'), position: 0 }],
    );
    qc.setQueryData(['item', C, 1, 'a/1'], item('a/1', 'Leviathan Wakes'));
    qc.setQueryData(['item', C, 1, 'a/0'], item('a/0', 'Not started'));
    save(qc);
    expect(keptBooks().data).toEqual([expect.objectContaining({ title: 'Leviathan Wakes' })]);
  });

  it('gives no place to a row with no book (an episode), so a book keeps its title', () => {
    const qc = newClient();
    const episodes = Array.from({ length: 15 }, (_, i) =>
      row(`pod/${i}`, `2026-10-2${i % 10}`, true),
    );
    qc.setQueryData(['progress', 'all', C], [...episodes, row('a/3', '2026-10-01', true)]);
    qc.setQueryData(['item', C, 1, 'a/3'], item('a/3', 'Finished'));
    save(qc);
    expect(keptBooks().data).toEqual([expect.objectContaining({ title: 'Finished' })]);
  });

  it('keeps a title this visit saved after its /item left the cache', () => {
    const qc = newClient();
    qc.setQueryData(['progress', 'all', C], [row('a/2', '2026-10-03')]);
    qc.setQueryData(['item', C, 1, 'a/2'], item('a/2', "Caliban's War"));
    save(qc);
    qc.removeQueries({ queryKey: ['item', C, 1, 'a/2'], exact: true });
    save(qc);
    expect(keptBooks().data).toEqual([expect.objectContaining({ title: "Caliban's War" })]);
  });

  it('restores them for the next visit, which keeps them while its /item is unasked', () => {
    const first = newClient();
    first.setQueryData(['progress', 'all', C], [row('a/2', '2026-10-03')]);
    first.setQueryData(['item', C, 1, 'a/2'], item('a/2', "Caliban's War"));
    save(first);

    const next = newClient();
    restore(next);
    expect(next.getQueryData([PROGRESS_BOOKS, C])).toEqual([
      expect.objectContaining({ rel_path: 'a/2', title: "Caliban's War" }),
    ]);
    // Never swept as idle: no screen observes it.
    expect(next.getQueryCache().find({ queryKey: [PROGRESS_BOOKS, C] })?.gcTime).toBe(Infinity);
    // Saved again with no /item this visit: the kept title stays, a book with no row goes.
    next.setQueryData(['progress', 'all', C], [row('a/2', '2026-10-04'), row('a/9', '2026-10-05')]);
    save(next);
    expect(keptBooks().data).toEqual([expect.objectContaining({ title: "Caliban's War" })]);
    next.setQueryData(['progress', 'all', C], [row('a/9', '2026-10-05')]);
    save(next);
    expect(keptBooks()).toBeUndefined();
  });

  it('writes after an in-progress book’s /item answers, not any other book’s', async () => {
    jest.useFakeTimers();
    try {
      const qc = newClient();
      qc.setQueryData(['progress', 'all', C], [row('a/2', '2026-10-03')]);
      const stop = startSaving(qc);
      await qc.fetchQuery({
        queryKey: ['item', C, 1, 'a/7'],
        queryFn: async () => item('a/7', 'X'),
      });
      jest.advanceTimersByTime(SAVE_DELAY_MS);
      expect(items.has(STARTUP_CACHE_KEY)).toBe(false);
      await qc.fetchQuery({
        queryKey: ['item', C, 1, 'a/2'],
        queryFn: async () => item('a/2', "Caliban's War"),
      });
      jest.advanceTimersByTime(SAVE_DELAY_MS);
      expect(keptBooks().data).toEqual([expect.objectContaining({ title: "Caliban's War" })]);
      stop();
    } finally {
      jest.useRealTimers();
    }
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

    // Hidden again with no new answer since: nothing to write.
    items.clear();
    listeners.get('pagehide')?.();
    expect(items.has(STARTUP_CACHE_KEY)).toBe(false);

    // A query the cache does not keep schedules nothing.
    items.clear();
    await qc.fetchQuery({ queryKey: ['item', C, 1, 'a'], queryFn: async () => ({}) });
    jest.advanceTimersByTime(SAVE_DELAY_MS);
    expect(items.has(STARTUP_CACHE_KEY)).toBe(false);

    stop();
    expect(listeners.size).toBe(0);
  });
});
