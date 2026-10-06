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
  };
}
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
  useAuthors,
  useBookMeta,
  useCapability,
  useLibraryBooks,
  useNarrators,
  useNextBook,
  useSeriesList,
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
  // gcTime Infinity: no garbage-collection timer is left running after the suite.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
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
