import { type InfiniteData, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Capabilities, Page } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// Each signed-in server is a stub client behind the provider's `useApis`, and a real
// QueryClient drives the infinite queries and their capability gates.
type Stub = {
  serverInfo: jest.Mock;
  allHistory: jest.Mock;
  myBookmarks: jest.Mock;
  myNotes: jest.Mock;
};
const page = (ids: number[], next?: string): Page<{ id: number }> => ({
  items: ids.map((id) => ({ id })),
  ...(next ? { next_cursor: next } : {}),
});
function stub(caps: Partial<Capabilities> | 'fails' | 'never'): Stub {
  return {
    serverInfo: jest.fn(() =>
      caps === 'fails'
        ? Promise.reject(new Error('unreachable'))
        : caps === 'never'
          ? new Promise(() => {})
          : Promise.resolve({ capabilities: caps }),
    ),
    allHistory: jest.fn(async () => page([1, 2], 'h2')),
    myBookmarks: jest.fn(async () => page([5])),
    myNotes: jest.fn(async () => page([])),
  };
}

let mockConnections: { connection: { id: string; name: string }; client: Stub }[] = [];
jest.mock('@/api/provider', () => ({ useApis: () => mockConnections }));

/* eslint-disable import/first */
import { qk } from '@/api/hooks';

import { useJournalSources } from './use-journal-sources';
/* eslint-enable import/first */

notifyQueriesSynchronously();

let qc: QueryClient;
afterEach(() => qc.clear());

async function mount(opts: { notes?: boolean } = {}, seed?: (qc: QueryClient) => void) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seed?.(qc);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook((props: { notes?: boolean }) => useJournalSources(props), {
    wrapper,
    initialProps: opts,
  });
}

beforeEach(() => {
  mockConnections = [
    { connection: { id: 'c1', name: 'Hearthside' }, client: stub({ annotations: true }) },
    { connection: { id: 'c2', name: "Maya's Shelf" }, client: stub({}) },
  ];
  mockConnections[1].client.allHistory.mockRejectedValue(new Error('down'));
});

describe('useJournalSources', () => {
  it("reports each server's lists, in connection order", async () => {
    const { result } = await mount();
    await waitFor(() => expect(result.current.notes[0].status).toBe('ready'));
    await waitFor(() => expect(result.current.history[1].status).toBe('error'));
    const { history, bookmarks, notes } = result.current;
    expect(history.map((s) => [s.connectionName, s.status, s.rows.length, s.hasNextPage])).toEqual([
      ['Hearthside', 'ready', 2, true],
      ["Maya's Shelf", 'error', 0, false],
    ]);
    // c2 has no `annotations`: it can't list them, never a load, and is never asked.
    expect(bookmarks.map((s) => [s.status, s.supported])).toEqual([
      ['ready', true],
      ['unsupported', false],
    ]);
    expect(notes.map((s) => s.status)).toEqual(['ready', 'unsupported']);
    expect(mockConnections[1].client.myBookmarks).not.toHaveBeenCalled();
    expect(mockConnections[1].client.myNotes).not.toHaveBeenCalled();
  });

  it('reads a server whose /server failed as failed, and its retry asks /server again', async () => {
    mockConnections[1].client = stub('fails');
    const { result } = await mount();
    await waitFor(() => expect(result.current.bookmarks[1].status).toBe('error'));
    expect(result.current.bookmarks[1].supported).toBe('unknown');
    const calls = mockConnections[1].client.serverInfo.mock.calls.length;
    await act(async () => result.current.bookmarks[1].refetch());
    expect(mockConnections[1].client.serverInfo.mock.calls.length).toBeGreaterThan(calls);
    // Still no flag: the list itself is never asked.
    expect(mockConnections[1].client.myBookmarks).not.toHaveBeenCalled();
  });

  it('loads while a flag is not known yet, and pages through the query', async () => {
    mockConnections[1].client = stub('never');
    const { result } = await mount();
    await waitFor(() => expect(result.current.history[0].status).toBe('ready'));
    expect(result.current.bookmarks[1].status).toBe('loading');
    await act(async () => result.current.history[0].fetchNextPage());
    await waitFor(() => expect(result.current.history[0].hasNextPage).toBe(true));
    expect(mockConnections[0].client.allHistory).toHaveBeenLastCalledWith(
      { limit: 100, cursor: 'h2' },
      expect.anything(),
    );
  });

  it('holds the notes back until they are wanted', async () => {
    const { result, rerender } = await mount({ notes: false });
    await waitFor(() => expect(result.current.bookmarks[0].status).toBe('ready'));
    expect(result.current.notes[0].status).toBe('loading');
    expect(mockConnections[0].client.myNotes).not.toHaveBeenCalled();
    const history = result.current.history;
    await rerender({ notes: true });
    await waitFor(() => expect(result.current.notes[0].status).toBe('ready'));
    // A page of notes never rebuilds the other lists.
    expect(result.current.history).toBe(history);
  });

  // The Notes tab's count, with nothing asked on the Diary: what an earlier visit loaded.
  it('reads the notes an earlier visit loaded while they are held back, asking nothing', async () => {
    const { result } = await mount({ notes: false }, (c) =>
      c.setQueryData(qk.myNotes('c1'), { pages: [page([7, 8])], pageParams: [undefined] }),
    );
    await waitFor(() => expect(result.current.notes[0].status).toBe('ready'));
    expect(result.current.notes[0].rows).toHaveLength(2);
    expect(mockConnections[0].client.myNotes).not.toHaveBeenCalled();
  });

  // A list read deep would refetch every page it holds, one after another, on a revisit.
  it('leaves each list with only its first page once the Journal closes', async () => {
    const { result, unmount } = await mount();
    await waitFor(() => expect(result.current.history[0].hasNextPage).toBe(true));
    await act(async () => result.current.history[0].fetchNextPage());
    await waitFor(() =>
      expect(qc.getQueryData<InfiniteData<unknown>>(qk.myHistory('c1'))!.pages).toHaveLength(2),
    );
    await act(async () => unmount());
    expect(qc.getQueryData<InfiniteData<unknown>>(qk.myHistory('c1'))!.pages).toHaveLength(1);
  });

  it('drops a removed server', async () => {
    const { result, rerender } = await mount();
    await waitFor(() => expect(result.current.history[0].status).toBe('ready'));
    mockConnections = [mockConnections[0]];
    await rerender({});
    expect(result.current.history.map((s) => s.connectionId)).toEqual(['c1']);
    expect(result.current.bookmarks.map((s) => s.connectionId)).toEqual(['c1']);
  });
});
