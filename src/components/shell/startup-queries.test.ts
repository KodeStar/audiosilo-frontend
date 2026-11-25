import { QueryClient } from '@tanstack/react-query';

import type { ApiConnection } from '@/api/provider';

// Only what the specs import (the module's own logic needs no provider).
let mockVisible: { id: string; token?: string }[] = [];
jest.mock('@/stores/profiles', () => ({ profileConnections: () => mockVisible }));
jest.mock('@/api/provider', () => ({ queryClient: null, useApis: () => [] }));

/* eslint-disable import/first */
import { libraryBooksQuery, qk, RECENT_LIMIT } from '@/api/hooks';

import {
  resetStartupQueries,
  STARTUP_WAIT_MS,
  startPage,
  startStartupQueries,
  startupQueries,
  startupQueriesComplete,
  subscribeStartupQueries,
  type StartupQuery,
} from './startup-queries';
/* eslint-enable import/first */

const api = (id: string) => ({ connection: { id }, client: {} }) as unknown as ApiConnection;
const keys = (qs: StartupQuery[]) => qs.map((q) => q.queryKey);

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

beforeEach(() => {
  resetStartupQueries();
  mockVisible = [];
});

describe('startPage', () => {
  it('names Home, the Library grid, and anything else', () => {
    expect(startPage('/')).toBe('home');
    expect(startPage('')).toBe('home');
    expect(startPage('/library')).toBe('library');
    expect(startPage('/library/', 'books')).toBe('library');
    expect(startPage('/library', 'authors')).toBe('other');
    expect(startPage('/library', null)).toBe('library');
    expect(startPage('/settings')).toBe('other');
  });
});

describe('startupQueries', () => {
  const flags = { queue: true, user_stats: true, household: true };
  const makeApi = (id: string, capabilities = flags) => {
    const mock = {
      serverInfo: jest.fn(async () => ({ capabilities })),
      libraries: jest.fn(async () => [
        { id: 1, name: 'Books' },
        { id: 2, name: 'Shows', kind: 'podcasts' },
      ]),
      allProgress: jest.fn(async () => []),
      recentBooks: jest.fn(async () => []),
      favourites: jest.fn(async () => []),
      queue: jest.fn(async () => []),
      myStats: jest.fn(async () => ({})),
      myListening: jest.fn(async () => ({})),
      listeningGoal: jest.fn(async () => ({})),
      household: jest.fn(async () => ({ share_listening: false })),
      listBooks: jest.fn(async () => ({ books: [] })),
    };
    return { api: { ...api(id), client: mock } as unknown as ApiConnection, mock };
  };

  const finished = async () => {
    if (!startupQueriesComplete())
      await new Promise<void>((resolve) => {
        const stop = subscribeStartupQueries(() => {
          stop();
          resolve();
        });
      });
  };

  it("warms Home's actual ranges, household settings and chosen queue only with their server flags", async () => {
    const a = makeApi('a'),
      b = makeApi('b'),
      older = makeApi('old', { queue: false, user_stats: false, household: false });
    const client = newClient();
    const apis = [a.api, b.api, older.api];
    mockVisible = apis.map(({ connection }) => connection);
    startStartupQueries(client, () => startupQueries('home', apis, null, 'a', 'b'));
    await finished();
    for (const {
      api: {
        connection: { id },
      },
      mock,
    } of [a, b, older]) {
      expect(client.getQueryData(qk.recent(id, RECENT_LIMIT))).toEqual([]);
      expect(client.getQueryData(qk.favourites(id))).toEqual([]);
      expect(client.getQueryData(qk.allProgress(id))).toEqual([]);
      expect(mock.serverInfo).toHaveBeenCalledTimes(1);
    }
    expect(a.mock.myListening).toHaveBeenCalledWith('1y', expect.anything());
    expect(a.mock.listeningGoal).toHaveBeenCalledTimes(1);
    expect(a.mock.queue).not.toHaveBeenCalled();
    expect(b.mock.queue).toHaveBeenCalledTimes(1);
    expect(b.mock.listeningGoal).not.toHaveBeenCalled();
    expect(b.mock.myListening).not.toHaveBeenCalled();
    for (const { mock } of [a, b]) {
      expect(mock.household).toHaveBeenCalledTimes(1);
      expect(mock.myStats).toHaveBeenCalledWith('30d', expect.anything());
    }
    for (const read of ['myListening', 'listeningGoal', 'myStats', 'queue', 'household'] as const)
      expect(older.mock[read]).not.toHaveBeenCalled();
  });

  it.each([
    [1, true],
    [2, false],
    [3, false],
  ])('warms only a listed book library (selection %s)', async (libraryId, asked) => {
    const { api, mock } = makeApi('a');
    const client = newClient();
    mockVisible = [api.connection];
    startStartupQueries(client, () =>
      startupQueries(
        'library',
        [api],
        { connectionId: 'a', libraryId: Number(libraryId) },
        'a',
        'a',
      ),
    );
    await finished();
    expect(mock.libraries).toHaveBeenCalledTimes(1);
    if (asked) {
      expect(mock.listBooks).toHaveBeenCalledTimes(1);
      expect(
        client.getQueryData(libraryBooksQuery('a', null, 1, { sort: 'recent' }, 200).queryKey),
      ).toEqual({ pages: [{ books: [] }], pageParams: [undefined] });
    } else expect(mock.listBooks).not.toHaveBeenCalled();
  });

  it('makes no gated Home request when the profile changes while /server is in flight', async () => {
    const { api, mock } = makeApi('a');
    mockVisible = [api.connection];
    const client = newClient();
    let answer!: () => void;
    mock.serverInfo.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { capabilities: flags };
    });
    startStartupQueries(client, () => startupQueries('home', [api], null, 'a', 'a'));
    mockVisible = [];
    answer();
    await finished();
    expect(mock.household).not.toHaveBeenCalled();
    expect(mock.myStats).not.toHaveBeenCalled();
    expect(mock.queue).not.toHaveBeenCalled();
  });

  it('never throws in the gate on a kept answer of an unexpected shape', async () => {
    const { api, mock } = makeApi('a');
    mockVisible = [api.connection];
    const client = newClient();
    client.setQueryData(qk.server('a'), null);
    client.setQueryData(qk.libraries('a'), { libraries: [] });
    for (const page of ['home', 'library'] as const) {
      resetStartupQueries();
      expect(() =>
        startStartupQueries(client, () =>
          startupQueries(page, [api], { connectionId: 'a', libraryId: 1 }, 'a', 'a'),
        ),
      ).not.toThrow();
      await finished();
    }
    expect(mock.listBooks).not.toHaveBeenCalled();
    expect(mock.household).not.toHaveBeenCalled();
  });

  it('any other page: only what the shell reads', () => {
    expect(keys(startupQueries('other', [api('a')], null, 'a', 'a'))).toEqual([
      qk.server('a'),
      qk.libraries('a'),
    ]);
  });
});

describe('startStartupQueries', () => {
  const query = (key: string, answer: Promise<void>, asked: string[]): StartupQuery => ({
    queryKey: [key],
    ask: () => {
      asked.push(key);
      return answer;
    },
  });

  it('waits for the answers the cache lacks, then lets the screen mount', async () => {
    const client = newClient();
    client.setQueryData(['kept'], 1);
    let answer!: () => void;
    const asked: string[] = [];
    const listener = jest.fn();
    subscribeStartupQueries(listener);
    startStartupQueries(client, () => [
      query('kept', Promise.resolve(), asked),
      query('new', new Promise((r) => (answer = r)), asked),
    ]);
    expect(asked).toEqual(['new']);
    expect(startupQueriesComplete()).toBe(false);
    answer();
    await Promise.resolve();
    await Promise.resolve();
    expect(startupQueriesComplete()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('waits for nothing when the cache holds every answer (a reload the startup cache filled)', () => {
    const client = newClient();
    client.setQueryData(['kept'], 1);
    const asked: string[] = [];
    startStartupQueries(client, () => [query('kept', Promise.resolve(), asked)]);
    expect(asked).toEqual([]);
    expect(startupQueriesComplete()).toBe(true);
  });

  it(`gives up after ${STARTUP_WAIT_MS} ms (a slow server gets the skeleton)`, () => {
    jest.useFakeTimers();
    try {
      startStartupQueries(newClient(), () => [query('slow', new Promise(() => {}), [])]);
      expect(startupQueriesComplete()).toBe(false);
      jest.advanceTimersByTime(STARTUP_WAIT_MS - 1);
      expect(startupQueriesComplete()).toBe(false);
      jest.advanceTimersByTime(1);
      expect(startupQueriesComplete()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks once per page load', () => {
    const asked: string[] = [];
    const client = newClient();
    startStartupQueries(client, () => [query('one', Promise.resolve(), asked)]);
    startStartupQueries(client, () => [query('two', Promise.resolve(), asked)]);
    expect(asked).toEqual(['one']);
  });
});
