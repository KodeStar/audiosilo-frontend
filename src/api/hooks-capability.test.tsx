import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Capabilities, ServerInfo } from '@/api/types';

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
  qk,
  useAddCollectionItem,
  useAddToQueue,
  useAuthors,
  useBookMeta,
  useCapability,
  useClearListeningGoal,
  useCollection,
  useCollections,
  useCreateCollection,
  useDeleteCollection,
  useDeleteRating,
  useEditProgress,
  useLibraryBooks,
  useListeningGoal,
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

type Flag = 'queue' | 'collections' | 'ratings' | 'progress_edit' | 'user_stats' | 'my_devices';
const ALL_1B: Flag[] = [
  'queue',
  'collections',
  'ratings',
  'progress_edit',
  'user_stats',
  'my_devices',
];
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
    const { result } = await mount({ c1: { collections: true } }, () => ({
      held: [useCollection(0), useShareTargets(false)],
      control: [useCollection(7), useShareTargets(true)],
    }));
    await waitFor(() => expect(result.current.control.every((q) => q.isSuccess)).toBe(true));
    expect(mockClients.c1.collection).toHaveBeenCalledTimes(1);
    expect(mockClients.c1.collection).toHaveBeenCalledWith(7, expect.anything());
    expect(mockClients.c1.shareTargets).toHaveBeenCalledTimes(1);
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
      expect(error).toMatchObject({ capability: flag });
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

  it('a progress edit stores the progress and refreshes the progress, stats and goal reads', async () => {
    const { result, qc } = await mountMutation(
      { progress_edit: true },
      'progress_edit',
      useEditProgress,
    );
    for (const key of [qk.allProgress('c1'), qk.myStats('c1', '30d'), qk.listeningGoal('c1')]) {
      qc.setQueryData(key, {});
    }
    await act(async () => {
      await result.current.m.mutateAsync({
        libraryId: 2,
        path: 'A/Book',
        edit: { finished: true },
      });
    });
    expect(qc.getQueryData(qk.progress('c1', 2, 'A/Book'))).toEqual({
      library_id: 2,
      path: 'A/Book',
    });
    expect(qc.getQueryState(qk.allProgress('c1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.myStats('c1', '30d'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.listeningGoal('c1'))?.isInvalidated).toBe(true);
  });

  it("a rating on a part path is cached under its book's path, and the asked path refreshes", async () => {
    const { result, qc } = await mountMutation({ ratings: true }, 'ratings', useSetRating);
    mockClients.c1.setRating.mockResolvedValueOnce({ library_id: 2, path: 'A/Book', rating: 5 });
    qc.setQueryData(qk.rating('c1', 2, 'A/Book/CD1'), null);
    qc.setQueryData(qk.myRatings('c1'), []);
    await act(async () => {
      await result.current.m.mutateAsync({ libraryId: 2, path: 'A/Book/CD1', rating: 5 });
    });
    expect(qc.getQueryData(qk.rating('c1', 2, 'A/Book'))).toMatchObject({ rating: 5 });
    expect(qc.getQueryState(qk.rating('c1', 2, 'A/Book/CD1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.myRatings('c1'))?.isInvalidated).toBe(true);
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
});
