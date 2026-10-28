import { QueryClient } from '@tanstack/react-query';

import type { ApiConnection } from '@/api/provider';

// Only what the specs import (the module's own logic needs no provider).
jest.mock('@/api/provider', () => ({ queryClient: null, useApis: () => [] }));

/* eslint-disable import/first */
import { libraryBooksKey, qk, RECENT_LIMIT } from '@/api/hooks';

import {
  resetStartupQueries,
  STARTUP_WAIT_MS,
  startPage,
  startStartupQueries,
  startupQueries,
  startupQueriesSettled,
  subscribeStartupQueries,
  type StartupQuery,
} from './startup-queries';
/* eslint-enable import/first */

const api = (id: string) => ({ connection: { id }, client: {} }) as unknown as ApiConnection;
const keys = (qs: StartupQuery[]) => qs.map((q) => q.queryKey);

beforeEach(() => resetStartupQueries());

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
  it("Home: every server's flags, libraries, progress, Recently added and favourites", () => {
    expect(keys(startupQueries('home', [api('a'), api('b')], null))).toEqual(
      ['a', 'b'].flatMap((cid) => [
        qk.server(cid),
        qk.libraries(cid),
        qk.allProgress(cid),
        qk.recent(cid, RECENT_LIMIT),
        qk.favourites(cid),
      ]),
    );
  });

  it("the Library grid: the selected library's whole list (the grid's own entry)", () => {
    const qs = keys(
      startupQueries('library', [api('a'), api('b')], { connectionId: 'b', libraryId: 3 }),
    );
    expect(qs).toEqual([
      qk.server('a'),
      qk.libraries('a'),
      qk.allProgress('a'),
      qk.server('b'),
      qk.libraries('b'),
      qk.allProgress('b'),
      libraryBooksKey('b', 3, { sort: 'recent' }, 200),
    ]);
    // No selection yet: no list (the grid picks the library once the lists are in).
    expect(keys(startupQueries('library', [api('a')], null))).not.toContainEqual(
      expect.arrayContaining(['libraryBooks']),
    );
  });

  it('any other page: only what the shell reads', () => {
    expect(keys(startupQueries('other', [api('a')], null))).toEqual([
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
    const client = new QueryClient();
    client.setQueryData(['kept'], 1);
    let answer!: () => void;
    const asked: string[] = [];
    const listener = jest.fn();
    subscribeStartupQueries(listener);
    startStartupQueries(client, [
      query('kept', Promise.resolve(), asked),
      query('new', new Promise((r) => (answer = r)), asked),
    ]);
    expect(asked).toEqual(['new']);
    expect(startupQueriesSettled()).toBe(false);
    answer();
    await Promise.resolve();
    await Promise.resolve();
    expect(startupQueriesSettled()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('waits for nothing when the cache holds every answer (a reload the startup cache filled)', () => {
    const client = new QueryClient();
    client.setQueryData(['kept'], 1);
    const asked: string[] = [];
    startStartupQueries(client, [query('kept', Promise.resolve(), asked)]);
    expect(asked).toEqual([]);
    expect(startupQueriesSettled()).toBe(true);
  });

  it(`gives up after ${STARTUP_WAIT_MS} ms (a slow server gets the skeleton)`, () => {
    jest.useFakeTimers();
    try {
      startStartupQueries(new QueryClient(), [query('slow', new Promise(() => {}), [])]);
      expect(startupQueriesSettled()).toBe(false);
      jest.advanceTimersByTime(STARTUP_WAIT_MS - 1);
      expect(startupQueriesSettled()).toBe(false);
      jest.advanceTimersByTime(1);
      expect(startupQueriesSettled()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks once per page load', () => {
    const asked: string[] = [];
    const client = new QueryClient();
    startStartupQueries(client, [query('one', Promise.resolve(), asked)]);
    startStartupQueries(client, [query('two', Promise.resolve(), asked)]);
    expect(asked).toEqual(['one']);
  });
});
