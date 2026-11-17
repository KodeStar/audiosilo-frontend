import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { ApiError } from '@/api/client';
import type { Favourite, Progress } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// A fan-out's `unreadError` (fe#271): a server's failure with nothing kept. A failed
// re-read of a list the server did answer is in `error` only, so a screen with no row in
// says "none" for a kept empty list, and Home's error agrees with `failed`.
const mockApis = [
  {
    connection: { id: 'a', name: 'Home' },
    client: { favourites: jest.fn(), allProgress: jest.fn() },
  },
  {
    connection: { id: 'b', name: "Maya's Shelf" },
    client: { favourites: jest.fn(), allProgress: jest.fn() },
  },
];
jest.mock('@/api/provider', () => ({
  useApis: () => mockApis,
  useOptionalApi: () => mockApis[0].client,
  useCid: (id?: string) => id ?? 'a',
}));
jest.mock('@/api/reachability', () => ({ noteFailure: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  bookPlace: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { qk, useAllProgressAll, useFavouritesAll } from '@/api/hooks';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const down = new TypeError('Network request failed');
const fav = { library_id: 1, path: 'Tolkien/The Hobbit', is_book: true } as Favourite;
const [a, b] = mockApis.map((x) => x.client);

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Infinite gcTime, so no garbage-collection timer keeps Jest from exiting.
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  b.favourites.mockResolvedValue([]);
  b.allProgress.mockResolvedValue([]);
});
afterEach(() => qc.clear());

describe("a fan-out's unreadError", () => {
  it('is the failure of a server with nothing kept', async () => {
    a.favourites.mockRejectedValue(down);
    const { result } = await renderHook(() => useFavouritesAll(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(down));
    expect(result.current.unreadError).toBe(down);
  });

  it('is not the failed re-read of a list kept with nothing in it', async () => {
    qc.setQueryData(qk.favourites('a'), []);
    a.favourites.mockRejectedValue(down);
    const { result } = await renderHook(() => useFavouritesAll(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(down));
    expect(result.current.unreadError).toBeNull();
    expect(result.current.favourites).toEqual([]);
  });

  it('is not the failed re-read of a list kept with rows in it', async () => {
    qc.setQueryData(qk.favourites('a'), [fav]);
    a.favourites.mockRejectedValue(down);
    const { result } = await renderHook(() => useFavouritesAll(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(down));
    expect(result.current.unreadError).toBeNull();
    expect(result.current.favourites.map((f) => f.path)).toEqual([fav.path]);
  });

  // `error` is the first failure of any kind; `unreadError` is of the servers in `failed`.
  it("passes over a kept list's failed re-read for the server with nothing kept", async () => {
    const refused = new Error('boom');
    qc.setQueryData(qk.allProgress('a'), [] as Progress[]);
    a.allProgress.mockRejectedValue(down);
    b.allProgress.mockRejectedValue(refused);
    const { result } = await renderHook(() => useAllProgressAll(), { wrapper });
    await waitFor(() => expect(result.current.failed).toEqual(['b']));
    await waitFor(() => expect(result.current.error).toBe(down));
    expect(result.current.unreadError).toBe(refused);
  });

  // fe#147 with fe#271: one server's refused sign-in must not hide another's trouble.
  it("names a server's trouble over another server's refused sign-in", async () => {
    a.allProgress.mockRejectedValue(new ApiError(401, 'signed out'));
    b.allProgress.mockRejectedValue(down);
    const { result } = await renderHook(() => useAllProgressAll(), { wrapper });
    await waitFor(() => expect(result.current.failed).toEqual(['a', 'b']));
    expect(result.current.unreadError).toBe(down);
    expect(result.current.refused).toEqual(['a']);
  });

  it('is null, as `failed` is empty, when only re-reads of kept progress failed', async () => {
    qc.setQueryData(qk.allProgress('a'), [] as Progress[]);
    a.allProgress.mockRejectedValue(down);
    const { result } = await renderHook(() => useAllProgressAll(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(down));
    expect(result.current.failed).toEqual([]);
    expect(result.current.unreadError).toBeNull();
  });
});
