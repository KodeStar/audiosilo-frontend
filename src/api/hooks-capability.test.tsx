import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { ApiClient } from '@/api/client';
import type { Capabilities, Page, ServerInfo } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// The capability-gated hooks must never send a request the connected server does not
// advertise (CROSS-REPO §15: shipped clients and older servers coexist). The provider is
// mocked to resolve each connection id to its own stub client (no id = the default
// connection, 'c1'), and a real QueryClient drives the gating.
function makeClient() {
  return {
    serverInfo: jest.fn(),
    authors: jest.fn(async () => ({ people: [], unknown: 0 })),
    narrators: jest.fn(async () => ({ people: [], unknown: 0 })),
    seriesList: jest.fn(async () => []),
    nextBook: jest.fn(async () => ({ source: 'none' })),
    // Two pages: the first carries a cursor to the second.
    listBooks: jest.fn(async (_lib: number, opts: { cursor?: string }) =>
      opts.cursor ? { books: [] } : { books: [], next_cursor: 'p2' },
    ),
    bookMeta: jest.fn(async () => ({ matched: false })),
    // Phase 1b user state: each answers like the server would, enough for the hooks'
    // cache updates.
    queue: jest.fn(async () => []),
    setQueue: jest.fn(async () => []),
    addToQueue: jest.fn(async () => []),
    removeFromQueue: jest.fn(async () => undefined),
    collections: jest.fn(async () => []),
    collection: jest.fn(async (id: number) => ({ collection: { id }, items: [] })),
    createCollection: jest.fn(async () => ({ id: 5 })),
    updateCollection: jest.fn(async (id: number) => ({ id, name: 'Renamed' })),
    deleteCollection: jest.fn(async () => undefined),
    setCollectionItems: jest.fn(async (id: number) => ({ collection: { id }, items: [] })),
    addCollectionItem: jest.fn(async (id: number) => ({ collection: { id }, items: [] })),
    removeCollectionItem: jest.fn(async () => undefined),
    setCollectionShares: jest.fn(async (id: number) => ({ id, shared_with: [] })),
    shareTargets: jest.fn(async () => []),
    rating: jest.fn(async () => null),
    setRating: jest.fn(async (lib: number, path: string, rating: number) => ({
      library_id: lib,
      path,
      rating,
    })),
    deleteRating: jest.fn(async () => undefined),
    myRatings: jest.fn(async () => []),
    editProgress: jest.fn(async (lib: number, path: string) => ({ library_id: lib, path })),
    myStats: jest.fn(async (_range?: string) => ({ range: '30d' })),
    myListening: jest.fn(async () => ({ range: '30d', days: [] })),
    listeningGoal: jest.fn(async () => ({ goal: null, year: '2026', finished: 0 })),
    setListeningGoal: jest.fn(async (n: number) => ({
      goal: { books_per_year: n, updated_at: 'now' },
      year: '2026',
      finished: 0,
    })),
    clearListeningGoal: jest.fn(async () => undefined),
    myDevices: jest.fn(async () => []),
    revokeMyDevice: jest.fn(async () => ({ current: false })),
    createApiKey: jest.fn(async () => ({ id: 13, token: 'secret' })),
    revokeApiKey: jest.fn(async () => undefined),
    // Phase 4 annotations. The across-books lists have two pages: the first carries a
    // cursor to the second.
    myBookmarks: jest.fn(async (page: { cursor?: string }) =>
      page.cursor ? { items: [] } : { items: [], next_cursor: 'b2' },
    ),
    myNotes: jest.fn(async (page: { cursor?: string }) =>
      page.cursor ? { items: [] } : { items: [], next_cursor: 'n2' },
    ),
    allHistory: jest.fn(async (_page: { cursor?: string }): Promise<object> => ({ items: [] })),
    addBookmark: jest.fn(async (lib: number, path: string, position: number) => ({
      id: 30,
      library_id: lib,
      path,
      position,
    })),
    updateBookmark: jest.fn(async (id: number, patch: object) => ({
      id,
      library_id: 2,
      path: 'A/Book',
      ...patch,
    })),
    deleteBookmark: jest.fn(async () => undefined),
    addNote: jest.fn(async () => ({ id: 40 })),
    updateNote: jest.fn(async (id: number, patch: object) => ({
      id,
      library_id: 2,
      path: 'A/Book',
      ...patch,
    })),
    deleteNote: jest.fn(async () => undefined),
  };
}
type StubClient = ReturnType<typeof makeClient>;
const mockClients: Record<string, ReturnType<typeof makeClient>> = {};
jest.mock('@/api/provider', () => ({
  useApi: (id?: string) => mockClients[id ?? 'c1'],
  useApis: () => [],
  useCid: (id?: string) => id ?? 'c1',
  useOptionalApi: (id?: string) => mockClients[id ?? 'c1'] ?? null,
}));
jest.mock('@/api/reachability', () => ({ noteError: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import {
  CapabilityError,
  flattenPages,
  qk,
  useAddBookmark,
  useAddCollectionItem,
  useAddNote,
  keepFirstPage,
  myBookmarksQuery,
  myHistoryQuery,
  myNotesQuery,
  useDeleteBookmark,
  useDeleteNote,
  useUpdateBookmark,
  useUpdateNote,
  useAddToQueue,
  useAuthors,
  useBookMeta,
  useCapability,
  useClearListeningGoal,
  useCollection,
  useCollections,
  useCreateApiKey,
  useCreateCollection,
  useDeleteCollection,
  useDeleteRating,
  useEditProgress,
  useLibraryBooks,
  useListeningGoal,
  useMarkFinished,
  useMyDevices,
  useMyListening,
  useMyRatings,
  useMyStats,
  useNarrators,
  useNextBook,
  useQueue,
  useRating,
  useRemoveCollectionItem,
  useRemoveFromQueue,
  useRevokeApiKey,
  useRevokeMyDevice,
  useSeriesList,
  useSetCollectionItems,
  useSetCollectionShares,
  useSetListeningGoal,
  useSetQueue,
  useSetRating,
  useShareTargets,
  useUpdateCollection,
} from '@/api/hooks';
/* eslint-enable import/first */

function serverWith(id: string, caps: Partial<Capabilities>): ServerInfo {
  return {
    name: 'S',
    server_id: id,
    version: '1.0.0',
    api: 'v1',
    capabilities: {
      admin_ui: true,
      web_player: true,
      transcode: false,
      upload: false,
      websocket: false,
      ...caps,
    },
    auth: { methods: [] },
  };
}

const queryClients: QueryClient[] = [];

notifyQueriesSynchronously();

/** Render `useHooks` against stub servers advertising `servers[id]`, one stub client per
 * connection id. A negative test then waits until the hooks have RENDERED with the
 * loaded capabilities (`useCapability` defined): renderHook publishes its result after
 * the hooks' own effects, so by then any gate that let a request through has sent it.
 * A positive test waits for the queries it expects to have succeeded, so their last
 * re-render lands inside waitFor rather than after the test. */
async function mount<T>(
  servers: Record<string, Partial<Capabilities>>,
  useHooks: () => T,
  setup?: () => void,
) {
  for (const [id, caps] of Object.entries(servers)) {
    mockClients[id] = makeClient();
    mockClients[id].serverInfo.mockResolvedValue(serverWith(id, caps));
  }
  setup?.();
  // gcTime Infinity: no garbage-collection timer (of a query or a mutation) is left
  // running after the suite.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  queryClients.push(qc);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(useHooks, { wrapper });
}

/** The three browse lists and the next book for one connection, and what its server
 * advertises (`[browse_people, next_book]`). */
function useBrowseAndNext(connectionId?: string) {
  return {
    lists: [
      useAuthors(2, connectionId),
      useNarrators(2, connectionId),
      useSeriesList(2, connectionId),
    ],
    next: useNextBook(2, 'Saga/Book 2', true, connectionId),
    caps: [useCapability('browse_people', connectionId), useCapability('next_book', connectionId)],
  };
}

afterEach(() => {
  for (const qc of queryClients.splice(0)) qc.clear();
  for (const id of Object.keys(mockClients)) delete mockClients[id];
});

describe('capability-gated hooks', () => {
  it('reports a capability as unknown until /server has answered', async () => {
    let answer: (info: ServerInfo) => void = () => {};
    const { result } = await mount(
      { c1: {} },
      () => [useCapability('next_book'), useCapability('browse_people')],
      () => mockClients.c1.serverInfo.mockReturnValue(new Promise((r) => (answer = r))),
    );
    expect(result.current).toEqual([undefined, undefined]);
    await act(async () => answer(serverWith('c1', { next_book: true })));
    await waitFor(() => expect(result.current).toEqual([true, false]));
  });

  it('sends nothing to a server without browse_people / next_book', async () => {
    const { result } = await mount({ c1: { metadata: true } }, () => {
      useLibraryBooks(2, { narrator: 'Kramer & Reading' });
      return useBrowseAndNext();
    });
    await waitFor(() => expect(result.current.caps).toEqual([false, false]));
    const c1 = mockClients.c1;
    expect(c1.authors).not.toHaveBeenCalled();
    expect(c1.narrators).not.toHaveBeenCalled();
    expect(c1.seriesList).not.toHaveBeenCalled();
    expect(c1.nextBook).not.toHaveBeenCalled();
    expect(c1.listBooks).not.toHaveBeenCalled();
  });

  it('asks for the browse lists on browse_people alone', async () => {
    const { result } = await mount({ c1: { browse_people: true } }, () => useBrowseAndNext());
    await waitFor(() => expect(result.current.lists.every((q) => q.isSuccess)).toBe(true));
    expect(result.current.caps).toEqual([true, false]);
    const c1 = mockClients.c1;
    expect(c1.authors).toHaveBeenCalledWith(2, expect.anything());
    expect(c1.narrators).toHaveBeenCalledWith(2, expect.anything());
    expect(c1.seriesList).toHaveBeenCalledWith(2, expect.anything());
    expect(c1.nextBook).not.toHaveBeenCalled();
  });

  it('asks for the next book on next_book alone', async () => {
    const { result } = await mount({ c1: { next_book: true } }, () => useBrowseAndNext());
    await waitFor(() => expect(result.current.next.isSuccess).toBe(true));
    expect(result.current.caps).toEqual([false, true]);
    const c1 = mockClients.c1;
    expect(c1.nextBook).toHaveBeenCalledWith(2, 'Saga/Book 2', expect.anything());
    expect(c1.authors).not.toHaveBeenCalled();
    expect(c1.narrators).not.toHaveBeenCalled();
    expect(c1.seriesList).not.toHaveBeenCalled();
  });

  it("asks the given connection's server, gated on that server's flags", async () => {
    const { result } = await mount(
      { c1: {}, c2: { browse_people: true, next_book: true } },
      () => ({ c2: useBrowseAndNext('c2'), c1: useBrowseAndNext() }),
    );
    await waitFor(() => {
      const { c1, c2 } = result.current;
      expect([...c2.lists, c2.next].every((q) => q.isSuccess)).toBe(true);
      expect(c1.caps).toEqual([false, false]);
    });
    expect(mockClients.c2.authors).toHaveBeenCalledWith(2, expect.anything());
    expect(mockClients.c2.nextBook).toHaveBeenCalledWith(2, 'Saga/Book 2', expect.anything());
    expect(mockClients.c1.authors).not.toHaveBeenCalled();
    expect(mockClients.c1.nextBook).not.toHaveBeenCalled();
  });

  it('does not ask a connection whose server lacks the flag, whatever the default has', async () => {
    const { result } = await mount({ c1: { browse_people: true, next_book: true }, c2: {} }, () => [
      useBrowseAndNext('c2').caps,
      useCapability('next_book'),
    ]);
    await waitFor(() => expect(result.current).toEqual([[false, false], true]));
    for (const c of [mockClients.c1, mockClients.c2]) {
      expect(c.authors).not.toHaveBeenCalled();
      expect(c.nextBook).not.toHaveBeenCalled();
    }
  });

  it('holds useNextBook while the caller disables it', async () => {
    const { result } = await mount({ c1: { next_book: true } }, () => {
      useNextBook(2, 'Saga/Book 2', false);
      return useNextBook(2, 'Saga/Book 3'); // the control: same server, enabled
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockClients.c1.nextBook).toHaveBeenCalledTimes(1);
    expect(mockClients.c1.nextBook).toHaveBeenCalledWith(2, 'Saga/Book 3', expect.anything());
  });

  it('never lets a manual refetch reach a server without the flag', async () => {
    // React Query reports the refused refetch on the console: the expected path here.
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = await mount({ c1: {} }, () => ({
        authors: useAuthors(2),
        next: useNextBook(2, 'Saga/Book 2'),
        known: useCapability('next_book'),
      }));
      await waitFor(() => expect(result.current.known).toBe(false));
      const refetched = await act(async () =>
        Promise.all([result.current.authors.refetch(), result.current.next.refetch()]),
      );
      // Refused without a request: each refetch comes back as an error, not a response.
      expect(refetched.map((r) => r.isError)).toEqual([true, true]);
      expect(mockClients.c1.authors).not.toHaveBeenCalled();
      expect(mockClients.c1.nextBook).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('useLibraryBooks', () => {
  it('filters by narrator once the server advertises browse_people', async () => {
    const { result } = await mount({ c1: { browse_people: true } }, () =>
      useLibraryBooks(2, { narrator: 'Kramer & Reading', sort: 'title' }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockClients.c1.listBooks).toHaveBeenCalledWith(
      2,
      { narrator: 'Kramer & Reading', sort: 'title', limit: 100, cursor: undefined },
      expect.anything(),
    );
  });

  it('filters by author on any server and pages on next_cursor', async () => {
    const { result } = await mount({ c1: {} }, () => useLibraryBooks(2, { author: 'Andy Weir' }));
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(mockClients.c1.listBooks.mock.calls.map((call) => call[1])).toEqual([
      { author: 'Andy Weir', limit: 100, cursor: undefined },
      { author: 'Andy Weir', limit: 100, cursor: 'p2' },
    ]);
  });
});

describe('useBookMeta', () => {
  it('keeps each request variant in its own cache entry', async () => {
    const { result } = await mount({ c1: { metadata: true, meta_bundle: true } }, () => [
      useBookMeta(2, 'A/Book', true),
      useBookMeta(2, 'A/Book', true, { includePrevious: true }),
    ]);
    await waitFor(() => expect(result.current.every((q) => q.isSuccess)).toBe(true));
    const { bookMeta } = mockClients.c1;
    expect(bookMeta).toHaveBeenCalledTimes(2);
    expect(bookMeta).toHaveBeenCalledWith(2, 'A/Book', expect.anything(), undefined);
    expect(bookMeta).toHaveBeenCalledWith(2, 'A/Book', expect.anything(), {
      includePrevious: true,
    });
  });
});

// --- User state & personal stats (Phase 1b) ----------------------------------
// Every useHook is gated on its OWN flag: the negative cases run against a server that
// advertises every other Phase 1b flag (so a useHook gated on the wrong flag, or not at
// all, sends a request and fails), the positive ones against a server with that flag
// alone.

const ALL_1B = [
  'queue',
  'collections',
  'ratings',
  'progress_edit',
  'user_stats',
  'my_devices',
] as const;
type Flag = (typeof ALL_1B)[number];
/** Every Phase 1b flag on except `flag` (and every 1a flag on, too). */
function allBut(flag: Flag): Partial<Capabilities> {
  const caps: Partial<Capabilities> = {
    metadata: true,
    cover_sizes: true,
    browse_people: true,
    next_book: true,
    meta_bundle: true,
  };
  for (const f of ALL_1B) caps[f] = f !== flag;
  return caps;
}

type QueryCase = {
  name: string;
  flag: Flag;
  useHook: () => { refetch: () => Promise<{ isError: boolean }>; isSuccess: boolean };
  method: keyof StubClient;
  args: unknown[];
};

const queryCases: QueryCase[] = [
  { name: 'useQueue', flag: 'queue', useHook: () => useQueue(), method: 'queue', args: [] },
  {
    name: 'useCollections',
    flag: 'collections',
    useHook: () => useCollections(),
    method: 'collections',
    args: [],
  },
  {
    name: 'useCollection',
    flag: 'collections',
    useHook: () => useCollection(5),
    method: 'collection',
    args: [5],
  },
  {
    name: 'useShareTargets',
    flag: 'collections',
    useHook: () => useShareTargets(),
    method: 'shareTargets',
    args: [],
  },
  {
    name: 'useRating',
    flag: 'ratings',
    useHook: () => useRating(2, 'A/Book'),
    method: 'rating',
    args: [2, 'A/Book'],
  },
  {
    name: 'useMyRatings',
    flag: 'ratings',
    useHook: () => useMyRatings(),
    method: 'myRatings',
    args: [],
  },
  {
    name: 'useMyStats',
    flag: 'user_stats',
    useHook: () => useMyStats('7d'),
    method: 'myStats',
    args: ['7d'],
  },
  {
    name: 'useMyListening',
    flag: 'user_stats',
    useHook: () => useMyListening(),
    method: 'myListening',
    args: ['30d'],
  },
  {
    name: 'useListeningGoal',
    flag: 'user_stats',
    useHook: () => useListeningGoal(),
    method: 'listeningGoal',
    args: [],
  },
  {
    name: 'useMyDevices',
    flag: 'my_devices',
    useHook: () => useMyDevices(),
    method: 'myDevices',
    args: [],
  },
];

describe('Phase 1b gated queries', () => {
  it.each(queryCases)(
    '$name asks nothing, even on refetch, of a server without $flag',
    async ({ flag, useHook, method }) => {
      const useCase = () => ({ q: useHook(), known: useCapability(flag) });
      // React Query reports the refused refetch on the console: the expected path here.
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { result } = await mount({ c1: allBut(flag) }, useCase);
        await waitFor(() => expect(result.current.known).toBe(false));
        const refetched = await act(async () => result.current.q.refetch());
        expect(refetched.isError).toBe(true);
        expect(mockClients.c1[method]).not.toHaveBeenCalled();
      } finally {
        quiet.mockRestore();
      }
    },
  );

  it.each(queryCases)(
    '$name asks a server with $flag alone',
    async ({ flag, useHook, method, args }) => {
      const { result } = await mount({ c1: { [flag]: true } }, useHook);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockClients.c1[method]).toHaveBeenCalledTimes(1);
      expect(mockClients.c1[method]).toHaveBeenCalledWith(...args, expect.anything());
    },
  );

  it("asks the given connection's server, gated on that server's flags", async () => {
    const { result } = await mount({ c1: {}, c2: { queue: true, user_stats: true } }, () => ({
      c2: [useQueue('c2'), useMyStats('1y', 'c2')],
      c1: [useQueue(), useMyStats('1y')],
      c1Known: useCapability('queue'),
    }));
    await waitFor(() => {
      expect(result.current.c2.every((q) => q.isSuccess)).toBe(true);
      expect(result.current.c1Known).toBe(false);
    });
    expect(mockClients.c2.queue).toHaveBeenCalled();
    expect(mockClients.c2.myStats).toHaveBeenCalledWith('1y', expect.anything());
    expect(mockClients.c1.queue).not.toHaveBeenCalled();
    expect(mockClients.c1.myStats).not.toHaveBeenCalled();
  });

  it('holds useCollection without an id and useShareTargets while disabled', async () => {
    // The control is a collection read only: a share-targets control would share the held
    // query's key, and React Query would dedupe an ungated request into it unnoticed.
    const { result } = await mount({ c1: { collections: true } }, () => ({
      held: [useCollection(0), useShareTargets(false)],
      control: useCollection(7),
    }));
    await waitFor(() => expect(result.current.control.isSuccess).toBe(true));
    expect(mockClients.c1.collection).toHaveBeenCalledTimes(1);
    expect(mockClients.c1.collection).toHaveBeenCalledWith(7, expect.anything());
    expect(mockClients.c1.shareTargets).not.toHaveBeenCalled();
  });

  it('keys each stats range on its own', async () => {
    const { result } = await mount({ c1: { user_stats: true } }, () => [
      useMyStats('7d'),
      useMyStats('2025'),
    ]);
    await waitFor(() => expect(result.current.every((q) => q.isSuccess)).toBe(true));
    expect(mockClients.c1.myStats.mock.calls.map((call) => call[0])).toEqual(['7d', '2025']);
  });
});

type MutationCase = {
  name: string;
  flag: Flag;
  useHook: () => { mutateAsync: (vars: never) => Promise<unknown> };
  vars: unknown;
  method: keyof StubClient;
  args: unknown[];
};

const ref = { library_id: 2, path: 'A/Book' };
const mutationCases: MutationCase[] = [
  {
    name: 'useSetQueue',
    flag: 'queue',
    useHook: useSetQueue,
    vars: [ref],
    method: 'setQueue',
    args: [[ref]],
  },
  {
    name: 'useAddToQueue',
    flag: 'queue',
    useHook: useAddToQueue,
    vars: { libraryId: 2, path: 'A/Book', position: 1 },
    method: 'addToQueue',
    args: [2, 'A/Book', 1],
  },
  {
    name: 'useRemoveFromQueue',
    flag: 'queue',
    useHook: useRemoveFromQueue,
    vars: { libraryId: 2, path: 'A/Book' },
    method: 'removeFromQueue',
    args: [2, 'A/Book'],
  },
  {
    name: 'useCreateCollection',
    flag: 'collections',
    useHook: useCreateCollection,
    vars: { name: 'Road trip' },
    method: 'createCollection',
    args: [{ name: 'Road trip' }],
  },
  {
    name: 'useUpdateCollection',
    flag: 'collections',
    useHook: useUpdateCollection,
    vars: { id: 5, name: 'Renamed' },
    method: 'updateCollection',
    args: [5, { name: 'Renamed' }],
  },
  {
    name: 'useDeleteCollection',
    flag: 'collections',
    useHook: useDeleteCollection,
    vars: 5,
    method: 'deleteCollection',
    args: [5],
  },
  {
    name: 'useSetCollectionItems',
    flag: 'collections',
    useHook: useSetCollectionItems,
    vars: { id: 5, items: [ref] },
    method: 'setCollectionItems',
    args: [5, [ref]],
  },
  {
    name: 'useAddCollectionItem',
    flag: 'collections',
    useHook: useAddCollectionItem,
    vars: { id: 5, libraryId: 2, path: 'A/Book' },
    method: 'addCollectionItem',
    args: [5, 2, 'A/Book', undefined],
  },
  {
    name: 'useRemoveCollectionItem',
    flag: 'collections',
    useHook: useRemoveCollectionItem,
    vars: { id: 5, libraryId: 2, path: 'A/Book' },
    method: 'removeCollectionItem',
    args: [5, 2, 'A/Book'],
  },
  {
    name: 'useSetCollectionShares',
    flag: 'collections',
    useHook: useSetCollectionShares,
    vars: { id: 5, userIds: [2] },
    method: 'setCollectionShares',
    args: [5, [2]],
  },
  {
    name: 'useSetRating',
    flag: 'ratings',
    useHook: useSetRating,
    vars: { libraryId: 2, path: 'A/Book', rating: 4, note: 'Good' },
    method: 'setRating',
    args: [2, 'A/Book', 4, 'Good'],
  },
  {
    name: 'useDeleteRating',
    flag: 'ratings',
    useHook: useDeleteRating,
    vars: { libraryId: 2, path: 'A/Book' },
    method: 'deleteRating',
    args: [2, 'A/Book'],
  },
  {
    name: 'useEditProgress',
    flag: 'progress_edit',
    useHook: useEditProgress,
    vars: { libraryId: 2, path: 'A/Book', edit: { finished: false } },
    method: 'editProgress',
    args: [2, 'A/Book', { finished: false }],
  },
  {
    name: 'useSetListeningGoal',
    flag: 'user_stats',
    useHook: useSetListeningGoal,
    vars: 24,
    method: 'setListeningGoal',
    args: [24],
  },
  {
    name: 'useClearListeningGoal',
    flag: 'user_stats',
    useHook: useClearListeningGoal,
    vars: undefined,
    method: 'clearListeningGoal',
    args: [],
  },
  {
    name: 'useRevokeMyDevice',
    flag: 'my_devices',
    useHook: useRevokeMyDevice,
    vars: 11,
    method: 'revokeMyDevice',
    args: [11],
  },
];

/** A stub answer held open until the test settles it with `release(value)`. */
function heldAnswer() {
  let settle: (value: unknown) => void = () => {};
  const promise = new Promise<never>((resolve) => {
    settle = resolve as (value: unknown) => void;
  });
  return { promise, release: (value: unknown) => settle(value) };
}

/** Mount mutation useHook `useHook` beside the flag it needs, and wait until that is known. */
async function mountMutation<T>(caps: Partial<Capabilities>, flag: Flag, useHook: () => T) {
  const r = await mount({ c1: caps }, () => ({ m: useHook(), known: useCapability(flag) }));
  await waitFor(() => expect(r.result.current.known).toBeDefined());
  return { ...r, qc: queryClients[queryClients.length - 1] };
}

describe('Phase 1b gated mutations', () => {
  it.each(mutationCases)(
    '$name rejects without a request on a server without $flag',
    async ({ flag, useHook, vars, method }) => {
      const { result } = await mountMutation(allBut(flag), flag, useHook);
      let error: unknown;
      await act(async () => {
        await result.current.m.mutateAsync(vars as never).catch((e: unknown) => (error = e));
      });
      expect(error).toBeInstanceOf(CapabilityError);
      expect(error).toMatchObject({ capability: flag, unknown: false });
      expect(mockClients.c1[method]).not.toHaveBeenCalled();
    },
  );

  it.each(mutationCases)(
    '$name sends its request to a server with $flag alone',
    async ({ flag, useHook, vars, method, args }) => {
      const { result } = await mountMutation({ [flag]: true }, flag, useHook);
      await act(async () => {
        await result.current.m.mutateAsync(vars as never);
      });
      expect(mockClients.c1[method]).toHaveBeenCalledTimes(1);
      expect(mockClients.c1[method]).toHaveBeenCalledWith(...args);
    },
  );

  it('rejects while the server capabilities are still unknown', async () => {
    const { result } = await mount(
      { c1: { queue: true } },
      () => useAddToQueue(),
      () => mockClients.c1.serverInfo.mockReturnValue(new Promise(() => {})),
    );
    let error: unknown;
    await act(async () => {
      await result.current
        .mutateAsync({ libraryId: 2, path: 'A/Book' })
        .catch((e: unknown) => (error = e));
    });
    expect(error).toBeInstanceOf(CapabilityError);
    // Not known yet is not "unsupported": the error says which it is.
    expect(error).toMatchObject({ capability: 'queue', unknown: true });
    expect(mockClients.c1.addToQueue).not.toHaveBeenCalled();
  });
});

describe('Phase 1b mutation cache updates', () => {
  it('stores the queue a write answers with', async () => {
    const { result, qc } = await mountMutation({ queue: true }, 'queue', useAddToQueue);
    const stored = [{ library_id: 2, path: 'A/Book', added_at: 'now' }];
    mockClients.c1.addToQueue.mockResolvedValueOnce(stored as never);
    await act(async () => {
      await result.current.m.mutateAsync({ libraryId: 2, path: 'A/Book/Part 1.mp3' });
    });
    expect(qc.getQueryData(qk.queue('c1'))).toEqual(stored);
  });

  /** A cached progress row (only the fields the cache updates look at). */
  const row = (path: string, extra: object = {}) => ({ library_id: 2, path, ...extra });
  /** A/Book's metadata, cut at the saved progress (spoilers=hide) and in full. */
  const hiddenMeta = qk.bookMeta('c1', 2, 'A/Book', { hideSpoilers: true });
  const fullMeta = qk.bookMeta('c1', 2, 'A/Book');

  it('a finishing progress edit patches its row in place and refreshes the stats and goal', async () => {
    const { result, qc } = await mountMutation(
      { progress_edit: true },
      'progress_edit',
      useEditProgress,
    );
    const stored = row('A/Book', { finished: true, finished_at: 'now' });
    mockClients.c1.editProgress.mockResolvedValueOnce(stored as never);
    qc.setQueryData(qk.allProgress('c1'), [row('Other'), row('A/Book', { finished: false })]);
    qc.setQueryData(qk.myStats('c1', '30d'), {});
    qc.setQueryData(qk.listeningGoal('c1'), {});
    qc.setQueryData(hiddenMeta, {});
    qc.setQueryData(fullMeta, {});
    await act(async () => {
      await result.current.m.mutateAsync({
        libraryId: 2,
        path: 'A/Book',
        edit: { finished: true },
      });
    });
    await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
    expect(qc.getQueryData(qk.progress('c1', 2, 'A/Book'))).toEqual(stored);
    expect(qc.getQueryData(qk.allProgress('c1'))).toEqual([row('Other'), stored]);
    expect(qc.getQueryState(qk.allProgress('c1'))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(qk.myStats('c1', '30d'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.listeningGoal('c1'))?.isInvalidated).toBe(true);
    // The server cuts the spoilers=hide envelope at the saved progress; the full one isn't.
    expect(qc.getQueryState(hiddenMeta)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(fullMeta)?.isInvalidated).toBe(false);
  });

  it('clearing a finish date also refreshes the stats and goal', async () => {
    const { result, qc } = await mountMutation(
      { progress_edit: true },
      'progress_edit',
      useEditProgress,
    );
    qc.setQueryData(qk.myStats('c1', '7d'), {});
    qc.setQueryData(qk.listeningGoal('c1'), {});
    qc.setQueryData(hiddenMeta, {});
    await act(async () => {
      await result.current.m.mutateAsync({
        libraryId: 2,
        path: 'A/Book',
        edit: { finished_at: null },
      });
    });
    await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
    expect(qc.getQueryState(qk.myStats('c1', '7d'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.listeningGoal('c1'))?.isInvalidated).toBe(true);
    // A date moves no position: the spoilers=hide cut stands.
    expect(qc.getQueryState(hiddenMeta)?.isInvalidated).toBe(false);
  });

  it('a progress edit that moves no finish inserts its row and leaves the stats and goal', async () => {
    const { result, qc } = await mountMutation(
      { progress_edit: true },
      'progress_edit',
      useEditProgress,
    );
    qc.setQueryData(qk.allProgress('c1'), [row('Other')]);
    qc.setQueryData(qk.myStats('c1', '30d'), {});
    qc.setQueryData(qk.listeningGoal('c1'), {});
    qc.setQueryData(hiddenMeta, {});
    await act(async () => {
      await result.current.m.mutateAsync({
        libraryId: 2,
        path: 'A/Book',
        edit: { position: 30, started_at: '2026-09-01' },
      });
    });
    await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
    expect(qc.getQueryData(qk.allProgress('c1'))).toEqual([row('A/Book'), row('Other')]);
    expect(qc.getQueryState(qk.allProgress('c1'))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(qk.myStats('c1', '30d'))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(qk.listeningGoal('c1'))?.isInvalidated).toBe(false);
    // A new position moves where the server cuts the spoilers=hide envelope.
    expect(qc.getQueryState(hiddenMeta)?.isInvalidated).toBe(true);
  });

  it('a progress edit keeps a refresh another writer left pending on the all-progress list', async () => {
    const { result, qc } = await mountMutation(
      { progress_edit: true },
      'progress_edit',
      useEditProgress,
    );
    qc.setQueryData(qk.allProgress('c1'), [row('Other')]);
    // Playback stopped another book while no screen showed the list: only marked stale.
    await act(() => qc.invalidateQueries({ queryKey: qk.allProgress('c1') }));
    await act(async () => {
      await result.current.m.mutateAsync({ libraryId: 2, path: 'A/Book', edit: { position: 5 } });
    });
    expect(qc.getQueryData(qk.allProgress('c1'))).toEqual([row('A/Book'), row('Other')]);
    expect(qc.getQueryState(qk.allProgress('c1'))?.isInvalidated).toBe(true);
  });

  it("a rating on a part path is cached under its book's path (the only one it changes)", async () => {
    const { result, qc } = await mountMutation({ ratings: true }, 'ratings', useSetRating);
    mockClients.c1.setRating.mockResolvedValueOnce({ library_id: 2, path: 'A/Book', rating: 5 });
    qc.setQueryData(qk.rating('c1', 2, 'A/Book/CD1'), null);
    qc.setQueryData(qk.myRatings('c1'), []);
    await act(async () => {
      await result.current.m.mutateAsync({ libraryId: 2, path: 'A/Book/CD1', rating: 5 });
    });
    await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
    expect(qc.getQueryData(qk.rating('c1', 2, 'A/Book'))).toMatchObject({ rating: 5 });
    // GET rating is exact-path: the part path's answer is unchanged, so not asked again.
    expect(qc.getQueryState(qk.rating('c1', 2, 'A/Book/CD1'))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(qk.myRatings('c1'))?.isInvalidated).toBe(true);
  });

  /** A cached collection (only the fields the cache updates look at). */
  const col = (id: number, owned: boolean, updated_at: string, extra: object = {}) => ({
    id,
    owned,
    updated_at,
    item_count: 1,
    ...extra,
  });

  it('an item write stores the detail and moves its collection in the list, in server order', async () => {
    const { result, qc } = await mountMutation(
      { collections: true },
      'collections',
      useAddCollectionItem,
    );
    // Owned first, newest updated_at first in each group, then the newest id.
    const list = [
      col(3, true, '2026-10-03T00:00:00.000Z'),
      col(2, true, '2026-10-02T00:00:00.000Z'),
      col(1, true, '2026-10-02T00:00:00.000Z'),
      col(9, false, '2026-10-05T00:00:00.000Z'),
    ];
    qc.setQueryData(qk.collections('c1'), list);
    const moved = col(1, true, '2026-10-06T00:00:00.000Z', { item_count: 2, preview: [] });
    const detail = { collection: moved, items: [] };
    mockClients.c1.addCollectionItem.mockResolvedValueOnce(detail as never);
    await act(async () => {
      await result.current.m.mutateAsync({ id: 1, libraryId: 2, path: 'A/Book' });
    });
    await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
    expect(qc.getQueryData(qk.collection('c1', 1))).toEqual(detail);
    expect(qc.getQueryData(qk.collections('c1'))).toEqual([moved, list[0], list[1], list[3]]);
    expect(qc.getQueryState(qk.collections('c1'))?.isInvalidated).toBe(false);
  });

  it.each([
    {
      name: 'a rename',
      useHook: useUpdateCollection,
      vars: { id: 2, name: 'Renamed' },
      method: 'updateCollection' as const,
    },
    {
      name: 'new shares',
      useHook: useSetCollectionShares,
      vars: { id: 2, userIds: [4] },
      method: 'setCollectionShares' as const,
    },
  ])('$name patches the cached detail and list entry', async ({ useHook, vars, method }) => {
    const { result, qc } = await mountMutation(
      { collections: true },
      'collections',
      useHook as () => ReturnType<typeof useUpdateCollection>,
    );
    const other = col(1, true, '2026-10-01T00:00:00.000Z');
    qc.setQueryData(qk.collections('c1'), [col(2, true, '2026-10-02T00:00:00.000Z'), other]);
    qc.setQueryData(qk.collection('c1', 2), { collection: { id: 2 }, items: ['kept'] });
    const stored = col(2, true, '2026-10-06T00:00:00.000Z', { name: 'Renamed' });
    mockClients.c1[method].mockResolvedValueOnce(stored as never);
    await act(async () => {
      await result.current.m.mutateAsync(vars as never);
    });
    await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
    expect(qc.getQueryData(qk.collection('c1', 2))).toEqual({
      collection: stored,
      items: ['kept'],
    });
    expect(qc.getQueryData(qk.collections('c1'))).toEqual([stored, other]);
    expect(qc.getQueryState(qk.collections('c1'))?.isInvalidated).toBe(false);
  });

  it('a write to a collection the cached list does not hold refreshes the list', async () => {
    const { result, qc } = await mountMutation(
      { collections: true },
      'collections',
      useSetCollectionItems,
    );
    qc.setQueryData(qk.collections('c1'), [col(1, true, '2026-10-01T00:00:00.000Z')]);
    await act(async () => {
      await result.current.m.mutateAsync({ id: 7, items: [] });
    });
    await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
    expect(qc.getQueryData(qk.collection('c1', 7))).toEqual({ collection: { id: 7 }, items: [] });
    expect(qc.getQueryState(qk.collections('c1'))?.isInvalidated).toBe(true);
  });

  it('removing an item (no answer) refreshes the detail and the list', async () => {
    const { result, qc } = await mountMutation(
      { collections: true },
      'collections',
      useRemoveCollectionItem,
    );
    qc.setQueryData(qk.collection('c1', 1), { collection: { id: 1 }, items: [] });
    qc.setQueryData(qk.collections('c1'), [col(1, true, '2026-10-01T00:00:00.000Z')]);
    await act(async () => {
      await result.current.m.mutateAsync({ id: 1, libraryId: 2, path: 'A/Book' });
    });
    await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
    expect(qc.getQueryState(qk.collection('c1', 1))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.collections('c1'))?.isInvalidated).toBe(true);
  });

  it('deleting a collection drops its detail and refreshes the list', async () => {
    const { result, qc } = await mountMutation(
      { collections: true },
      'collections',
      useDeleteCollection,
    );
    qc.setQueryData(qk.collection('c1', 5), { collection: { id: 5 }, items: [] });
    qc.setQueryData(qk.collections('c1'), []);
    await act(async () => {
      await result.current.m.mutateAsync(5);
    });
    expect(qc.getQueryState(qk.collection('c1', 5))).toBeUndefined();
    expect(qc.getQueryState(qk.collections('c1'))?.isInvalidated).toBe(true);
  });

  it('revoking another device refreshes the device and API key lists', async () => {
    const { result, qc } = await mountMutation(
      { my_devices: true },
      'my_devices',
      useRevokeMyDevice,
    );
    qc.setQueryData(qk.myDevices('c1'), []);
    qc.setQueryData(qk.apiKeys('c1'), []);
    await act(async () => {
      await result.current.m.mutateAsync(12);
    });
    expect(qc.getQueryState(qk.myDevices('c1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.apiKeys('c1'))?.isInvalidated).toBe(true);
  });

  it('revoking this device refetches nothing (its token is dead) and reports current', async () => {
    const { result, qc } = await mountMutation(
      { my_devices: true },
      'my_devices',
      useRevokeMyDevice,
    );
    mockClients.c1.revokeMyDevice.mockResolvedValueOnce({ current: true });
    qc.setQueryData(qk.myDevices('c1'), []);
    let res: unknown;
    await act(async () => {
      res = await result.current.m.mutateAsync(11);
    });
    expect(res).toEqual({ current: true });
    expect(qc.getQueryState(qk.myDevices('c1'))?.isInvalidated).toBe(false);
  });

  it('clearing the goal keeps the year and count, with no goal', async () => {
    const { result, qc } = await mountMutation(
      { user_stats: true },
      'user_stats',
      useClearListeningGoal,
    );
    qc.setQueryData(qk.listeningGoal('c1'), {
      goal: { books_per_year: 12, updated_at: 'then' },
      year: '2026',
      finished: 4,
    });
    await act(async () => {
      await result.current.m.mutateAsync();
    });
    expect(qc.getQueryData(qk.listeningGoal('c1'))).toEqual({
      goal: null,
      year: '2026',
      finished: 4,
    });
  });

  it("keeps a write's answer over a read of the same key that was already in flight", async () => {
    const { result, qc } = await mountMutation({ queue: true }, 'queue', () => ({
      queue: useQueue(),
      add: useAddToQueue(),
    }));
    await waitFor(() => expect(result.current.m.queue.isSuccess).toBe(true));
    const stored = [{ library_id: 2, path: 'A/Book', added_at: 'now' }];
    const oldRead = heldAnswer();
    mockClients.c1.queue
      .mockImplementationOnce(() => oldRead.promise)
      .mockResolvedValue(stored as never);
    mockClients.c1.addToQueue.mockResolvedValueOnce(stored as never);
    // A read starts (a mount refetch, a reconnect) and is still out when the add answers.
    await act(async () => {
      void result.current.m.queue.refetch();
    });
    await act(async () => {
      await result.current.m.add.mutateAsync({ libraryId: 2, path: 'A/Book' });
    });
    // The old read now lands with the queue from before the add: it must not win.
    await act(async () => oldRead.release([]));
    await waitFor(() => expect(qc.getQueryState(qk.queue('c1'))?.fetchStatus).toBe('idle'));
    expect(qc.getQueryData(qk.queue('c1'))).toEqual(stored);
  });

  it('reads a list again when its first load was in flight during a write', async () => {
    const before = col(1, true, '2026-10-01T00:00:00.000Z');
    const after = col(1, true, '2026-10-06T00:00:00.000Z', { item_count: 2 });
    const firstLoad = heldAnswer();
    const { result } = await mount(
      { c1: { collections: true } },
      () => ({ list: useCollections(), add: useAddCollectionItem() }),
      () =>
        mockClients.c1.collections
          .mockImplementationOnce(() => firstLoad.promise)
          .mockResolvedValue([after] as never),
    );
    const qc = queryClients[queryClients.length - 1];
    await waitFor(() =>
      expect(qc.getQueryState(qk.collections('c1'))?.fetchStatus).toBe('fetching'),
    );
    mockClients.c1.addCollectionItem.mockResolvedValueOnce({
      collection: after,
      items: [],
    } as never);
    await act(async () => {
      await result.current.add.mutateAsync({ id: 1, libraryId: 2, path: 'A/Book' });
    });
    await act(async () => firstLoad.release([before]));
    await waitFor(() => expect(result.current.list.data).toEqual([after]));
  });

  it('reads an errored list again after a write', async () => {
    const renamed = col(1, true, '2026-10-06T00:00:00.000Z', { name: 'Renamed' });
    const { result } = await mount(
      { c1: { collections: true } },
      () => ({ list: useCollections(), rename: useUpdateCollection() }),
      () =>
        mockClients.c1.collections
          .mockRejectedValueOnce(new Error('503 from a proxy'))
          .mockResolvedValue([renamed] as never),
    );
    await waitFor(() => expect(result.current.list.isError).toBe(true));
    mockClients.c1.updateCollection.mockResolvedValueOnce(renamed as never);
    await act(async () => {
      await result.current.rename.mutateAsync({ id: 1, name: 'Renamed' });
    });
    await waitFor(() => expect(result.current.list.data).toEqual([renamed]));
  });

  it('deleting the collection a screen shows keeps its data and asks nothing more', async () => {
    const { result, qc } = await mountMutation({ collections: true }, 'collections', () => ({
      detail: useCollection(5),
      remove: useDeleteCollection(),
    }));
    await waitFor(() => expect(result.current.m.detail.isSuccess).toBe(true));
    await act(async () => {
      await result.current.m.remove.mutateAsync(5);
    });
    await act(async () => {});
    expect(mockClients.c1.collection).toHaveBeenCalledTimes(1);
    expect(result.current.m.detail.data).toEqual({ collection: { id: 5 }, items: [] });
    // Marked stale, so the next screen to show it asks the server (and learns it's gone).
    expect(qc.getQueryState(qk.collection('c1', 5))?.isInvalidated).toBe(true);
  });

  it('marking a book finished refreshes the stats, the goal and the spoilers=hide metadata', async () => {
    const { result, qc } = await mountMutation({ user_stats: true }, 'user_stats', useMarkFinished);
    qc.setQueryData(qk.myStats('c1', '30d'), {});
    qc.setQueryData(qk.listeningGoal('c1'), {});
    qc.setQueryData(hiddenMeta, {});
    qc.setQueryData(fullMeta, {});
    await act(async () => {
      await result.current.m.mutateAsync({
        libraryId: 2,
        path: 'A/Book',
        position: 10,
        duration: 100,
      });
    });
    expect(qc.getQueryState(qk.myStats('c1', '30d'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.listeningGoal('c1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(hiddenMeta)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(fullMeta)?.isInvalidated).toBe(false);
  });

  it('creating or revoking an API key refreshes the device list too', async () => {
    const { result, qc } = await mountMutation({ my_devices: true }, 'my_devices', () => ({
      create: useCreateApiKey(),
      revoke: useRevokeApiKey(),
    }));
    qc.setQueryData(qk.myDevices('c1'), []);
    await act(async () => {
      await result.current.m.create.mutateAsync('cron');
    });
    expect(qc.getQueryState(qk.myDevices('c1'))?.isInvalidated).toBe(true);
    qc.setQueryData(qk.myDevices('c1'), []);
    await act(async () => {
      await result.current.m.revoke.mutateAsync(13);
    });
    expect(qc.getQueryState(qk.myDevices('c1'))?.isInvalidated).toBe(true);
  });

  it("runs a connection's writes of one capability one at a time, in order", async () => {
    const { result, qc } = await mountMutation({ queue: true }, 'queue', useAddToQueue);
    const first = [{ library_id: 2, path: 'A', added_at: '1' }];
    const second = [...first, { library_id: 2, path: 'B', added_at: '2' }];
    const firstAdd = heldAnswer();
    mockClients.c1.addToQueue
      .mockImplementationOnce(() => firstAdd.promise)
      .mockResolvedValueOnce(second as never);
    let writes: Promise<unknown>[] = [];
    await act(async () => {
      writes = [
        result.current.m.mutateAsync({ libraryId: 2, path: 'A' }),
        result.current.m.mutateAsync({ libraryId: 2, path: 'B' }),
      ];
    });
    // The second add waits for the first, so the server applies them in order...
    expect(mockClients.c1.addToQueue).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstAdd.release(first);
      await Promise.all(writes);
    });
    expect(mockClients.c1.addToQueue).toHaveBeenCalledTimes(2);
    // ...and the cache ends on the later answer.
    expect(qc.getQueryData(qk.queue('c1'))).toEqual(second);
  });

  it('keeps each write on the connection it was made on when the hook switches', async () => {
    let connection = 'c1';
    const { result, rerender } = await mount({ c1: { queue: true }, c2: { queue: true } }, () => ({
      m: useSetQueue(connection),
      known: useCapability('queue', connection),
    }));
    await waitFor(() => expect(result.current.known).toBe(true));
    const qc = queryClients[queryClients.length - 1];
    const stored = [{ library_id: 2, path: 'A/Book', added_at: 'now' }];
    const first = heldAnswer();
    mockClients.c1.setQueue
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(stored as never);
    let writes: Promise<unknown>[] = [];
    await act(async () => {
      // The second write waits for the first (same capability and connection).
      writes = [result.current.m.mutateAsync([]), result.current.m.mutateAsync([])];
    });
    // The hook switches to another connection while both are out.
    connection = 'c2';
    await act(async () => rerender({}));
    await act(async () => {
      first.release([]);
      await Promise.all(writes);
    });
    expect(mockClients.c1.setQueue).toHaveBeenCalledTimes(2);
    expect(mockClients.c2.setQueue).not.toHaveBeenCalled();
    expect(qc.getQueryData(qk.queue('c1'))).toEqual(stored);
    expect(qc.getQueryData(qk.queue('c2'))).toBeUndefined();
  });
});

// --- Annotations (Phase 4) -----------------------------------------------------
// Negative cases run against a server with every other flag on, so a hook gated on the
// wrong flag (or not at all) sends a request and fails.

/** Every flag on except `annotations`. */
const ALL_BUT_ANNOTATIONS: Partial<Capabilities> = {
  ...allBut('queue'),
  queue: true,
  annotations: false,
};

/** Mount `useHooks` beside the `annotations` flag, and wait until that is known. */
async function mountAnnotations<T>(caps: Partial<Capabilities>, useHooks: () => T) {
  const r = await mount({ c1: caps }, () => ({
    m: useHooks(),
    known: useCapability('annotations'),
  }));
  await waitFor(() => expect(r.result.current.known).toBeDefined());
  return { ...r, qc: queryClients[queryClients.length - 1] };
}

type PagedCase = {
  name: string;
  useHook: () => {
    refetch: () => Promise<{ isError: boolean }>;
    fetchNextPage: () => Promise<unknown>;
    isSuccess: boolean;
    hasNextPage: boolean;
  };
  method: keyof StubClient;
  next: string;
};

/** An across-books list read as the Journal reads it (`useJournalSources`): through its
 * option factory, told whether the connection's server has `annotations`. */
const client = (cid: string) => mockClients[cid] as unknown as ApiClient;
const useMyBookmarks = (cid = 'c1') =>
  useInfiniteQuery(myBookmarksQuery(cid, client(cid), useCapability('annotations', cid) === true));
const useMyNotes = (cid = 'c1') =>
  useInfiniteQuery(myNotesQuery(cid, client(cid), useCapability('annotations', cid) === true));
const useAllHistory = () => useInfiniteQuery(myHistoryQuery('c1', client('c1')));

const pagedCases: PagedCase[] = [
  { name: 'myBookmarksQuery', useHook: () => useMyBookmarks(), method: 'myBookmarks', next: 'b2' },
  { name: 'myNotesQuery', useHook: () => useMyNotes(), method: 'myNotes', next: 'n2' },
];

describe('Phase 4 across-books lists', () => {
  it.each(pagedCases)(
    '$name asks nothing, even on refetch, of a server without annotations',
    async ({ useHook, method }) => {
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { result } = await mountAnnotations(ALL_BUT_ANNOTATIONS, useHook);
        expect(result.current.known).toBe(false);
        const refetched = await act(async () => result.current.m.refetch());
        expect(refetched.isError).toBe(true);
        expect(mockClients.c1[method]).not.toHaveBeenCalled();
      } finally {
        quiet.mockRestore();
      }
    },
  );

  it.each(pagedCases)(
    '$name asks a server with annotations alone, page by page on next_cursor',
    async ({ useHook, method, next }) => {
      const { result } = await mountAnnotations({ annotations: true }, useHook);
      await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
      expect(result.current.m.hasNextPage).toBe(true);
      await act(async () => {
        await result.current.m.fetchNextPage();
      });
      expect(result.current.m.hasNextPage).toBe(false);
      expect(mockClients.c1[method].mock.calls).toEqual([
        [{ limit: 100, cursor: undefined }, expect.anything()],
        [{ limit: 100, cursor: next }, expect.anything()],
      ]);
    },
  );

  // A list read deep would refetch every page it holds, one after another, on a revisit.
  it.each(pagedCases)(
    '$name keeps only its first page once nothing reads it, and its date',
    async ({ useHook, method }) => {
      const { result, unmount, qc } = await mountAnnotations({ annotations: true }, useHook);
      await waitFor(() => expect(result.current.m.isSuccess).toBe(true));
      await act(async () => {
        await result.current.m.fetchNextPage();
      });
      const key = method === 'myBookmarks' ? qk.myBookmarks('c1') : qk.myNotes('c1');
      const before = qc.getQueryState(key)!.dataUpdatedAt;
      // Still read: left alone.
      keepFirstPage(qc, key);
      expect(qc.getQueryData<InfiniteData<unknown>>(key)!.pages).toHaveLength(2);
      await act(async () => unmount());
      keepFirstPage(qc, key);
      const kept = qc.getQueryData<InfiniteData<unknown>>(key)!;
      expect(kept.pages).toHaveLength(1);
      expect(kept.pageParams).toEqual([undefined]);
      expect(qc.getQueryState(key)!.dataUpdatedAt).toBe(before);
    },
  );

  it("asks the given connection's server, gated on that server's flag", async () => {
    const { result } = await mount({ c1: {}, c2: { annotations: true } }, () => ({
      c2: [useMyBookmarks('c2'), useMyNotes('c2')],
      c1: [useMyBookmarks(), useMyNotes()],
      c1Known: useCapability('annotations'),
    }));
    await waitFor(() => {
      expect(result.current.c2.every((q) => q.isSuccess)).toBe(true);
      expect(result.current.c1Known).toBe(false);
    });
    expect(mockClients.c1.myBookmarks).not.toHaveBeenCalled();
    expect(mockClients.c1.myNotes).not.toHaveBeenCalled();
  });

  it('reads history on any server, an older one (no next_cursor) as exactly one page', async () => {
    const span = { id: 1, library_id: 2, path: 'A/Book' };
    const { result } = await mount(
      { c1: {} },
      () => useAllHistory(),
      () => mockClients.c1.allHistory.mockResolvedValue({ items: [span] }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
    expect(flattenPages(result.current.data)).toEqual([span]);
    expect(mockClients.c1.allHistory).toHaveBeenCalledTimes(1);
    expect(mockClients.c1.allHistory).toHaveBeenCalledWith(
      { limit: 100, cursor: undefined },
      expect.anything(),
    );
  });

  it('pages history on next_cursor, and a recorded span (historyAll) reads it again', async () => {
    const { result } = await mount(
      { c1: { annotations: true } },
      () => useAllHistory(),
      () =>
        mockClients.c1.allHistory.mockImplementation(async (page) =>
          page.cursor ? { items: [{ id: 2 }] } : { items: [{ id: 1 }], next_cursor: 'h2' },
        ),
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(flattenPages(result.current.data)).toEqual([{ id: 1 }, { id: 2 }]);
    const qc = queryClients[queryClients.length - 1];
    // What store.ts does after recording a listening span.
    await act(async () => {
      await qc.invalidateQueries({ queryKey: qk.historyAll('c1') });
    });
    expect(mockClients.c1.allHistory).toHaveBeenCalledTimes(4);
  });
});

type EditCase = {
  name: string;
  useHook: () => { mutateAsync: (vars: never) => Promise<unknown> };
  vars: unknown;
  method: keyof StubClient;
  args: unknown[];
};

const editCases: EditCase[] = [
  {
    name: 'useUpdateBookmark',
    useHook: useUpdateBookmark,
    vars: { id: 7, label: 'quote' },
    method: 'updateBookmark',
    args: [7, { label: 'quote' }],
  },
  {
    name: 'useUpdateNote',
    useHook: useUpdateNote,
    vars: { id: 8, body: 'Edited', position: 12 },
    method: 'updateNote',
    args: [8, { body: 'Edited', position: 12 }],
  },
];

describe('Phase 4 gated edits', () => {
  it.each(editCases)(
    '$name rejects without a request on a server without annotations',
    async ({ useHook, vars, method }) => {
      const { result } = await mountAnnotations(ALL_BUT_ANNOTATIONS, useHook);
      let error: unknown;
      await act(async () => {
        await result.current.m.mutateAsync(vars as never).catch((e: unknown) => (error = e));
      });
      expect(error).toBeInstanceOf(CapabilityError);
      expect(error).toMatchObject({ capability: 'annotations', unknown: false });
      expect(mockClients.c1[method]).not.toHaveBeenCalled();
    },
  );

  it.each(editCases)(
    '$name rejects while the server capabilities are still unknown',
    async ({ useHook, vars, method }) => {
      const { result } = await mount({ c1: { annotations: true } }, useHook, () =>
        mockClients.c1.serverInfo.mockReturnValue(new Promise(() => {})),
      );
      let error: unknown;
      await act(async () => {
        await result.current.mutateAsync(vars as never).catch((e: unknown) => (error = e));
      });
      expect(error).toMatchObject({ capability: 'annotations', unknown: true });
      expect(mockClients.c1[method]).not.toHaveBeenCalled();
    },
  );

  it.each(editCases)(
    '$name sends its request to a server with annotations alone',
    async ({ useHook, vars, method, args }) => {
      const { result } = await mountAnnotations({ annotations: true }, useHook);
      await act(async () => {
        await result.current.m.mutateAsync(vars as never);
      });
      expect(mockClients.c1[method]).toHaveBeenCalledTimes(1);
      expect(mockClients.c1[method]).toHaveBeenCalledWith(...args);
    },
  );
});

describe('Phase 4 bookmark labels on add', () => {
  it('sends the label to a server with annotations', async () => {
    const { result } = await mountAnnotations({ annotations: true }, () =>
      useAddBookmark(2, 'A/Book'),
    );
    await act(async () => {
      await result.current.m.mutateAsync({ position: 61, label: 'funny' });
    });
    expect(mockClients.c1.addBookmark).toHaveBeenCalledWith(2, 'A/Book', 61, '', 'funny');
  });

  it('drops the label on a server without annotations, still making the bookmark', async () => {
    const { result } = await mountAnnotations(ALL_BUT_ANNOTATIONS, () =>
      useAddBookmark(2, 'A/Book'),
    );
    await act(async () => {
      await result.current.m.mutateAsync({ position: 61, note: 'Here', label: 'funny' });
    });
    expect(mockClients.c1.addBookmark.mock.calls).toEqual([[2, 'A/Book', 61, 'Here']]);
  });

  it('drops the label while the server capabilities are still unknown', async () => {
    const { result } = await mount(
      { c1: { annotations: true } },
      () => useAddBookmark(2, 'A/Book'),
      () => mockClients.c1.serverInfo.mockReturnValue(new Promise(() => {})),
    );
    await act(async () => {
      await result.current.mutateAsync({ position: 61, label: 'funny' });
    });
    expect(mockClients.c1.addBookmark.mock.calls).toEqual([[2, 'A/Book', 61, '']]);
  });
});

describe('Phase 4 cache updates', () => {
  const bookmark = (id: number, extra: object = {}) => ({
    id,
    library_id: 2,
    path: 'A/Book',
    position: id * 10,
    note: '',
    label: '',
    ...extra,
  });
  const note = (id: number, position: number, extra: object = {}) => ({
    id,
    library_id: 2,
    path: 'A/Book',
    position,
    body: 'b',
    ...extra,
  });
  const pages = (...lists: object[][]) => ({
    pages: lists.map((items, i) =>
      i < lists.length - 1 ? { items, next_cursor: `p${i + 2}` } : { items },
    ),
    pageParams: lists.map((_, i) => (i === 0 ? undefined : `p${i + 1}`)),
  });
  const book = { title: 'Book' };
  /** The rows of a cached across-books list. */
  const rows = (qc: QueryClient, key: readonly unknown[]) =>
    flattenPages(qc.getQueryData<InfiniteData<Page<unknown>>>(key));

  it("an edited bookmark replaces its row in the book's list and the across-books pages", async () => {
    const { result, qc } = await mountAnnotations({ annotations: true }, useUpdateBookmark);
    qc.setQueryData(qk.bookmarks('c1', 2, 'A/Book'), [bookmark(1), bookmark(2)]);
    qc.setQueryData(qk.myBookmarks('c1'), pages([{ ...bookmark(2), book }], [bookmark(1)]));
    mockClients.c1.updateBookmark.mockResolvedValueOnce(bookmark(2, { label: 'quote' }) as never);
    await act(async () => {
      await result.current.m.mutateAsync({ id: 2, label: 'quote' });
    });
    expect(qc.getQueryData(qk.bookmarks('c1', 2, 'A/Book'))).toEqual([
      bookmark(1),
      bookmark(2, { label: 'quote' }),
    ]);
    // The row keeps its `book` (an edit answers without it), and the list is read again.
    expect(rows(qc, qk.myBookmarks('c1'))).toEqual([
      { ...bookmark(2, { label: 'quote' }), book },
      bookmark(1),
    ]);
    expect(qc.getQueryState(qk.myBookmarks('c1'))?.isInvalidated).toBe(true);
  });

  it("an edited note keeps its book's list in position order", async () => {
    const { result, qc } = await mountAnnotations({ annotations: true }, useUpdateNote);
    qc.setQueryData(qk.notes('c1', 2, 'A/Book'), [note(1, 10), note(2, 20), note(3, 30)]);
    qc.setQueryData(qk.myNotes('c1'), pages([note(3, 30), note(2, 20)], [note(1, 10)]));
    mockClients.c1.updateNote.mockResolvedValueOnce(note(1, 25, { body: 'moved' }) as never);
    await act(async () => {
      await result.current.m.mutateAsync({ id: 1, position: 25 });
    });
    expect(qc.getQueryData(qk.notes('c1', 2, 'A/Book'))).toEqual([
      note(2, 20),
      note(1, 25, { body: 'moved' }),
      note(3, 30),
    ]);
    // The across-books list stays newest made first: the row changes in place.
    expect(rows(qc, qk.myNotes('c1'))).toEqual([
      note(3, 30),
      note(2, 20),
      note(1, 25, { body: 'moved' }),
    ]);
    expect(qc.getQueryState(qk.myNotes('c1'))?.isInvalidated).toBe(true);
  });

  it("an edit to a row the caches don't hold reads them again", async () => {
    const { result, qc } = await mountAnnotations({ annotations: true }, useUpdateBookmark);
    qc.setQueryData(qk.bookmarks('c1', 2, 'A/Book'), [bookmark(1)]);
    qc.setQueryData(qk.myBookmarks('c1'), pages([bookmark(1)]));
    await act(async () => {
      await result.current.m.mutateAsync({ id: 9, note: 'x' });
    });
    expect(qc.getQueryState(qk.bookmarks('c1', 2, 'A/Book'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.myBookmarks('c1'))?.isInvalidated).toBe(true);
  });

  it('a delete takes the row out of the across-books pages and refreshes both lists', async () => {
    const { result, qc } = await mountAnnotations({ annotations: true }, () => ({
      bookmark: useDeleteBookmark(2, 'A/Book'),
      note: useDeleteNote(2, 'A/Book'),
    }));
    qc.setQueryData(qk.bookmarks('c1', 2, 'A/Book'), [bookmark(1), bookmark(2)]);
    qc.setQueryData(qk.myBookmarks('c1'), pages([bookmark(2)], [bookmark(1)]));
    qc.setQueryData(qk.notes('c1', 2, 'A/Book'), [note(1, 10)]);
    qc.setQueryData(qk.myNotes('c1'), pages([note(1, 10)]));
    await act(async () => {
      await result.current.m.bookmark.mutateAsync(2);
      await result.current.m.note.mutateAsync(1);
    });
    expect(rows(qc, qk.myBookmarks('c1'))).toEqual([bookmark(1)]);
    expect(rows(qc, qk.myNotes('c1'))).toEqual([]);
    for (const key of [
      qk.bookmarks('c1', 2, 'A/Book'),
      qk.myBookmarks('c1'),
      qk.notes('c1', 2, 'A/Book'),
      qk.myNotes('c1'),
    ]) {
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it('an add refreshes the book list and the across-books list', async () => {
    const { result, qc } = await mountAnnotations({ annotations: true }, () => ({
      bookmark: useAddBookmark(2, 'A/Book'),
      note: useAddNote(2, 'A/Book'),
    }));
    for (const key of [
      qk.bookmarks('c1', 2, 'A/Book'),
      qk.myBookmarks('c1'),
      qk.notes('c1', 2, 'A/Book'),
      qk.myNotes('c1'),
    ]) {
      qc.setQueryData(key, key[0] === 'myBookmarks' || key[0] === 'myNotes' ? pages([]) : []);
    }
    await act(async () => {
      await result.current.m.bookmark.mutateAsync({ position: 5 });
      await result.current.m.note.mutateAsync({ body: 'n' });
    });
    for (const key of [
      qk.bookmarks('c1', 2, 'A/Book'),
      qk.myBookmarks('c1'),
      qk.notes('c1', 2, 'A/Book'),
      qk.myNotes('c1'),
    ]) {
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });
});
