import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { BookMeta, Capabilities, Progress } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// Two servers: `a` advertises the Phase 1 flags, `b` is an older server with none. The
// stub clients record what each was asked, so the gates are checked by what was sent.
function makeClient(id: string, caps: Partial<Capabilities>, progress: Partial<Progress>[]) {
  return {
    serverInfo: jest.fn(async () => ({ server_id: id, capabilities: caps })),
    libraries: jest.fn(async () => [{ id: 1, name: 'Books' }]),
    authors: jest.fn(async () => ({
      people: [{ name: 'Jim Butcher', books: 7, duration: 1 }],
      unknown: 0,
    })),
    narrators: jest.fn(async () => ({ people: [], unknown: 0 })),
    seriesList: jest.fn(async () => [
      { name: 'The Dresden Files', author: 'Jim Butcher', books: 4, duration: 1, positions: [] },
    ]),
    allProgress: jest.fn(async () => progress),
    bookMeta: jest.fn(async (_lib: number, path: string): Promise<BookMeta> => ({
      matched: true,
      web_url: '',
      work: {
        id: path,
        title: `Work ${path}`,
        authors: [],
        language: 'en',
        characters: [
          { id: 'early', name: 'Early Bird', reveal: { chapter: 1 } },
          { id: 'mid', name: 'Middle Child', reveal: { chapter: 3 } },
          { id: 'late', name: 'Late Comer', reveal: { chapter: 4 } },
        ],
      },
    })),
    chapters: jest.fn(async (_lib: number, _path: string) => ({
      chapters: [0, 100, 200, 300].map((start, index) => ({
        index,
        title: '',
        file_index: 0,
        file_path: 'b.m4b',
        start,
        end: start + 100,
        book_offset: start,
      })),
      files: [{ rel_path: 'b.m4b', duration: 400 }],
    })),
  };
}

const row = (
  path: string,
  position: number,
  finished: boolean,
  updated_at: string,
): Partial<Progress> => ({ library_id: 1, path, position, duration: 400, finished, updated_at });

const mockA = makeClient('a', { browse_people: true, metadata: true, series_memberships: true }, [
  row('in-progress', 250, false, '2026-10-03T00:00:00Z'),
  row('finished', 400, true, '2026-10-02T00:00:00Z'),
  row('unstarted', 0, false, '2026-10-01T00:00:00Z'),
]);
const mockB = makeClient('b', {}, [row('on-b', 100, false, '2026-10-04T00:00:00Z')]);
jest.mock('@/api/provider', () => ({
  useApis: () => [
    { connection: { id: 'a', name: 'Home Library' }, client: mockA },
    { connection: { id: 'b', name: "Maya's Shelf" }, client: mockB },
  ],
  useApiRegistry: () => ({
    clients: new Map([
      ['a', mockA],
      ['b', mockB],
    ]),
  }),
}));
jest.mock('@/api/reachability', () => ({ noteError: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({ nowPlaying: null })),
    selectBookKey: () => null,
    selectBookPosition: () => 0,
  };
});

/* eslint-disable import/first */
import { matchCharacters } from './search-model';
import { useCharacterSources, usePeopleSources } from './use-search-sources';
/* eslint-enable import/first */

function mount<T>(useHook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(useHook, { wrapper });
}

beforeEach(() => jest.clearAllMocks());

notifyQueriesSynchronously();

describe('usePeopleSources', () => {
  it('lists every library of the servers with browse_people, and never asks one without', async () => {
    const { result } = await mount(() => usePeopleSources(true));
    await waitFor(() => expect(result.current.series).toHaveLength(1));
    expect(result.current.supported).toBe(true);
    expect(result.current.authors[0]).toEqual({
      source: { connectionId: 'a', connectionName: 'Home Library', libraryId: 1 },
      items: [{ name: 'Jim Butcher', books: 7, duration: 1 }],
    });
    expect(mockB.authors).not.toHaveBeenCalled();
    expect(mockB.seriesList).not.toHaveBeenCalled();
    // A book counts in every series it is in where the server can say so.
    expect(mockA.seriesList).toHaveBeenCalledWith(1, { memberships: true }, expect.anything());
  });

  it('fetches nothing while disabled', async () => {
    const { result } = await mount(() => usePeopleSources(false));
    await waitFor(() => expect(result.current.supported).toBe(true));
    expect(mockA.authors).not.toHaveBeenCalled();
  });
});

describe('useCharacterSources', () => {
  it("gates each started book by the listener's place in it", async () => {
    const { result } = await mount(() => useCharacterSources(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.books).toHaveLength(2));
    const [inProgress, finished] = result.current.books;
    // 250 s into four 100 s chapters: chapter 3.
    expect(inProgress).toMatchObject({
      path: 'in-progress',
      listening: { chapter: 3, finished: false },
    });
    expect(finished).toMatchObject({ path: 'finished', listening: { finished: true } });

    // Only the started books on the metadata server were asked; chapters only for the
    // unfinished one.
    expect(mockA.bookMeta.mock.calls.map((c) => c[1])).toEqual(['in-progress', 'finished']);
    expect(mockA.chapters.mock.calls.map((c) => c[1])).toEqual(['in-progress']);
    expect(mockB.bookMeta).not.toHaveBeenCalled();

    // End to end: "Late Comer" (chapter 4) is met only in the finished book.
    const late = matchCharacters([inProgress], 'comer');
    expect(late.hits).toEqual([]);
    expect(late.hidden).toBe(1);
    expect(matchCharacters([inProgress], 'middle').hits).toHaveLength(1);
  });

  it('asks nothing while disabled', async () => {
    const { result } = await mount(() => useCharacterSources(false));
    await waitFor(() => expect(result.current.supported).toBe(true));
    expect(mockA.allProgress).not.toHaveBeenCalled();
    expect(mockA.bookMeta).not.toHaveBeenCalled();
  });
});
