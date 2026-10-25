import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Favourite } from '@/api/types';

// useToggleFavourite on a folder `/fs` flags `pending_book` (server#193): the server
// derives a favourite's is_book from its index, so the hook reads the book first (the
// on-demand index the book screen also triggers) or Favourites and Home would open it
// as a folder.
const calls: string[] = [];
const mockItem = jest.fn(async (_lib: number, path: string) => {
  calls.push(`item ${path}`);
  return {};
});
const mockAdd = jest.fn(async (_lib: number, path: string) => {
  calls.push(`add ${path}`);
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
import { qk, useToggleFavourite } from '@/api/hooks';
/* eslint-enable import/first */

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  calls.length = 0;
  mockItem.mockClear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => qc.clear());

async function toggle(vars: Parameters<ReturnType<typeof useToggleFavourite>['mutateAsync']>[0]) {
  const { result } = await renderHook(() => useToggleFavourite(), { wrapper });
  // The optimistic stub, read before the settle refetch replaces it.
  let stub: Favourite | undefined;
  const unsubscribe = qc.getQueryCache().subscribe(() => {
    stub ??= qc.getQueryData<Favourite[]>(qk.favourites('c'))?.find((f) => f.path === vars.path);
  });
  await act(async () => {
    await result.current.mutateAsync(vars);
  });
  unsubscribe();
  return stub;
}

describe('useToggleFavourite', () => {
  it('reads a pending book before hearting it, and stubs it as a book', async () => {
    const stub = await toggle({ libraryId: 1, path: 'A/New Book', on: true, pendingBook: true });
    expect(calls).toEqual(['item A/New Book', 'add A/New Book']);
    expect(stub?.is_book).toBe(true);
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

  it('never reads the book when removing a pending favourite', async () => {
    await toggle({ libraryId: 1, path: 'A/New Book', on: false, pendingBook: true });
    expect(calls).toEqual(['remove A/New Book']);
  });
});
