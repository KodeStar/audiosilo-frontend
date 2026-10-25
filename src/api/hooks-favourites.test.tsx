import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Favourite } from '@/api/types';

// useToggleFavourite on a folder `/fs` flags `pending_book` (server#193): the server
// derives a favourite's is_book from its index, so the hook also reads the book (the
// on-demand index the book screen also triggers) before the list is read again, or
// Favourites and Home would open it as a folder.
const calls: string[] = [];
const mockItem = jest.fn(async (_lib: number, path: string) => {
  calls.push(`item ${path}`);
  return {};
});
// The favourites cache as the add saw it: the optimistic stub, before the settle refetch.
let listAtAdd: Favourite[] | undefined;
const mockAdd = jest.fn(async (_lib: number, path: string) => {
  calls.push(`add ${path}`);
  listAtAdd = qc.getQueryData<Favourite[]>(qk.favourites('c'));
});
const mockRemove = jest.fn(async (_lib: number, path: string) => {
  calls.push(`remove ${path}`);
});
jest.mock('@/api/provider', () =>
  // `require` because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    c: {
      item: (l: number, p: string) => mockItem(l, p),
      addFavourite: (l: number, p: string) => mockAdd(l, p),
      removeFavourite: (l: number, p: string) => mockRemove(l, p),
      favourites: async () => [],
    },
  }),
);

/* eslint-disable import/first */
import { qk, type ToggleFavouriteVars, useToggleFavourite } from '@/api/hooks';
/* eslint-enable import/first */

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  calls.length = 0;
  listAtAdd = undefined;
  // Infinite gcTime on both, so no garbage-collection timer keeps Jest from exiting.
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
});
afterEach(() => qc.clear());

async function toggle(vars: ToggleFavouriteVars) {
  const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync(vars);
  });
  return listAtAdd?.find((f) => f.path === vars.path);
}

describe('useToggleFavourite', () => {
  it('reads a pending book as it hearts it, and stubs it as a book', async () => {
    const stub = await toggle({ libraryId: 1, path: 'A/New Book', on: true, pendingBook: true });
    expect([...calls].sort()).toEqual(['add A/New Book', 'item A/New Book']);
    expect(stub?.is_book).toBe(true);
    // The read lands in the item cache, so the book screen opened next asks nothing.
    expect(qc.getQueryData(qk.item('c', 1, 'A/New Book'))).toEqual({});
  });

  it('still hearts a pending book when the read fails', async () => {
    mockItem.mockRejectedValueOnce(new Error('boom'));
    await toggle({ libraryId: 1, path: 'A/New Book', on: true, pendingBook: true });
    expect(calls).toEqual(['add A/New Book']);
  });

  it('hearts a plain folder without reading it, stubbed as a folder', async () => {
    const stub = await toggle({ libraryId: 1, path: 'A', on: true });
    expect(calls).toEqual(['add A']);
    expect(stub?.is_book).toBe(false);
  });

  it('sends an unheart tapped during the read after the add, and reads the list once', async () => {
    let finishRead!: () => void;
    mockItem.mockImplementationOnce(async (_lib: number, path: string) => {
      calls.push(`item ${path}`);
      await new Promise<void>((resolve) => (finishRead = resolve));
      return {};
    });
    const listReads = jest.spyOn(qc, 'invalidateQueries');
    const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
    const vars = { libraryId: 1, path: 'A/New Book', pendingBook: true };
    let heart!: Promise<unknown>;
    let unheart!: Promise<unknown>;
    await act(async () => {
      heart = result.current.mutateAsync({ ...vars, on: true });
      unheart = result.current.mutateAsync({ ...vars, on: false });
    });
    // The unheart waits behind the heart's read.
    expect(calls).not.toContain('remove A/New Book');
    await act(async () => {
      finishRead();
      await Promise.all([heart, unheart]);
    });
    expect(calls.indexOf('remove A/New Book')).toBeGreaterThan(calls.indexOf('add A/New Book'));
    const favouriteReads = listReads.mock.calls.filter(
      ([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(qk.favourites('c')),
    );
    expect(favouriteReads).toHaveLength(1);
  });

  it('never reads the book when removing a pending favourite', async () => {
    await toggle({ libraryId: 1, path: 'A/New Book', on: false, pendingBook: true });
    expect(calls).toEqual(['remove A/New Book']);
  });
});
