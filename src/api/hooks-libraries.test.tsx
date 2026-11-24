import AsyncStorage from '@react-native-async-storage/async-storage';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { PROGRESS_MIRROR_KEY } from '@/lib/storage-keys';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// `useLibrariesAll` across two servers whose lists both failed: a server's own Retry
// (`retryServer`, Folders mode, CONNECT-06) asks only that server again.
const mockApis = [
  {
    connection: { id: 'a', name: 'Home' },
    client: {
      libraries: jest.fn(),
      listBooks: jest.fn(),
      serverInfo: jest.fn(),
      allProgress: jest.fn(),
    },
  },
  {
    connection: { id: 'b', name: "Maya's Shelf" },
    client: { libraries: jest.fn(), allProgress: jest.fn() },
  },
];
jest.mock('@/api/provider', () => ({
  useApis: () => mockApis,
  useOptionalApi: () => mockApis[0].client,
  useCid: (id?: string) => id ?? 'a',
}));
jest.mock('@/api/reachability', () => ({ noteFailure: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  ...jest.requireActual('@/playback/progress-sync'),
  bookPlace: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import {
  useAllLibraryBooks,
  useAllProgressAll,
  useLibrariesAll,
  useProgressLookup,
} from '@/api/hooks';
/* eslint-enable import/first */

notifyQueriesSynchronously();

it("asks only that server again on a server's own Retry", async () => {
  const [a, b] = mockApis.map((x) => x.client.libraries);
  a.mockRejectedValue(new TypeError('Network request failed'));
  b.mockRejectedValue(new TypeError('Network request failed'));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  try {
    const { result } = await renderHook(() => useLibrariesAll(), { wrapper });
    await waitFor(() =>
      expect(result.current.groups.map((g) => g.status)).toEqual(['error', 'error']),
    );
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    await act(async () => result.current.retryServer('b'));
    await waitFor(() => expect(b).toHaveBeenCalledTimes(2));
    expect(a).toHaveBeenCalledTimes(1);
  } finally {
    qc.clear();
  }
});

it('marks a list that waits for the network (offline before it answered) as paused (fe#155)', async () => {
  const [a, b] = mockApis.map((x) => x.client.libraries);
  a.mockResolvedValue([]);
  b.mockResolvedValue([]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  onlineManager.setOnline(false);
  try {
    const { result } = await renderHook(() => useLibrariesAll(), { wrapper });
    await waitFor(() =>
      expect(result.current.groups.map((g) => [g.status, g.paused])).toEqual([
        ['loading', true],
        ['loading', true],
      ]),
    );
    // Not loading (no skeleton for good): offline until the network is back.
    expect(result.current.isLoading).toBe(false);
    await act(async () => onlineManager.setOnline(true));
    await waitFor(() =>
      expect(result.current.groups.map((g) => [g.status, g.paused])).toEqual([
        ['ready', false],
        ['ready', false],
      ]),
    );
    expect(result.current.isLoading).toBe(false);
  } finally {
    onlineManager.setOnline(true);
    qc.clear();
  }
});

// fe#179 (the RC3 re-check): the Library grid's whole-library read, held for the network
// with nothing loaded, is `offline`: its screen shows the offline state, not a skeleton
// that never ends.
it('says a whole-library read that waits for the network is offline, then loads it', async () => {
  const { listBooks, serverInfo } = mockApis[0].client;
  serverInfo!.mockResolvedValue({ capabilities: {} });
  listBooks!.mockResolvedValue({ books: [{ rel_path: 'Dune' }], next_cursor: '' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  onlineManager.setOnline(false);
  try {
    const { result } = await renderHook(() => useAllLibraryBooks(1, { sort: 'recent' }, 'a'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.offline).toBe(true));
    expect(result.current.books).toEqual([]);
    expect(listBooks).not.toHaveBeenCalled();
    await act(async () => onlineManager.setOnline(true));
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current).toMatchObject({ offline: false, isLoading: false });
    expect(result.current.books).toEqual([{ rel_path: 'Dune' }]);
  } finally {
    onlineManager.setOnline(true);
    qc.clear();
  }
});

// The Library's "Couldn't load every book · Retry": a refetch of a list that had loaded every
// page failed. There is no next page to ask for, so Retry reads the list again.
it('sends the refetch again when a refetch of a fully loaded list failed', async () => {
  const { listBooks, serverInfo } = mockApis[0].client;
  serverInfo!.mockResolvedValue({ capabilities: {} });
  listBooks!.mockReset().mockResolvedValue({ books: [{ rel_path: 'Dune' }], next_cursor: '' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  try {
    const { result } = await renderHook(() => useAllLibraryBooks(1, { sort: 'recent' }, 'a'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.complete).toBe(true));
    listBooks!.mockRejectedValueOnce(new TypeError('Network request failed'));
    await act(async () => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(listBooks).toHaveBeenCalledTimes(2);
    await act(async () => result.current.retry());
    await waitFor(() => expect(listBooks).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.books).toEqual([{ rel_path: 'Dune' }]);
  } finally {
    qc.clear();
  }
});

// fe#147: a server's refusal (a 401) has its own sign-in state, so the fan-out's error is
// another server's trouble when there is one, and the refusing server is named.
it("names the server that refused the sign-in, and keeps another server's error", async () => {
  const [a, b] = mockApis.map((x) => x.client.allProgress);
  a.mockRejectedValue(new ApiError(401, 'unauthorized'));
  b.mockRejectedValue(new ApiError(500, 'boom'));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  try {
    const { result } = await renderHook(() => useAllProgressAll(), { wrapper });
    await waitFor(() => expect(result.current.error).toMatchObject({ status: 500 }));
    expect(result.current.refused).toEqual(['a']);
  } finally {
    qc.clear();
  }
});

it('shows a newer local place in both lists and lookups only for its own connection', async () => {
  const row = {
    library_id: 1,
    path: 'A',
    position: 10,
    duration: 100,
    finished: false,
    version: 1,
    playback_speed: 1,
    device_id: 'server',
    updated_at: '2026-03-01T00:00:00Z',
  };
  for (const api of mockApis) api.client.allProgress.mockResolvedValue([row]);
  const local = {
    ...row,
    connectionId: 'a',
    libraryId: 1,
    position: 40,
    updated_at: '2026-03-02T00:00:00Z',
  };
  await AsyncStorage.setItem(
    PROGRESS_MIRROR_KEY,
    JSON.stringify({
      'a:1:A': local,
      'other:1:hidden': { ...local, path: 'hidden', connectionId: 'other' },
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  try {
    const { result } = await renderHook(
      () => ({ all: useAllProgressAll(), lookup: useProgressLookup() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.lookup.progressOf('a', 1, 'A')?.position).toBe(40));
    expect(result.current.all.progress.map((p) => [p.connectionId, p.position])).toEqual([
      ['a', 40],
      ['b', 10],
    ]);
    expect(result.current.lookup.progressOf('b', 1, 'A')?.position).toBe(10);
    expect(result.current.lookup.progressOf('other', 1, 'hidden')).toBeUndefined();
  } finally {
    qc.clear();
    await AsyncStorage.removeItem(PROGRESS_MIRROR_KEY);
  }
});
