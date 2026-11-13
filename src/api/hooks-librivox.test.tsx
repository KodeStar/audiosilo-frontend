import { type Query, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { ApiError } from '@/api/client';
import type { BridgeJob, ServerInfo } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// The LibriVox hooks (LibriVox L6): the reads ask only a server with the flag (`metadata`
// for the catalogue, `bridge` for the job; the page's own gate is its mount); an Add seeds
// the job's own read and asks the works again whatever the answer; a job is polled while
// open and never again once it is gone.
function makeClient() {
  return {
    serverInfo: jest.fn<Promise<ServerInfo>, []>(),
    librivoxSearch: jest.fn(),
    librivoxWork: jest.fn(),
    librivoxFetch: jest.fn(),
    bridgeJob: jest.fn(),
    cancelBridgeJob: jest.fn(),
  };
}
const mockClients: Record<string, ReturnType<typeof makeClient>> = {};
jest.mock('@/api/provider', () => ({
  useApi: (id?: string) => mockClients[id ?? 'c1'],
  useApis: () => [],
  useCid: (id?: string) => id ?? 'c1',
  useOptionalApi: (id?: string) => mockClients[id ?? 'c1'] ?? null,
}));
jest.mock('@/api/reachability', () => ({ noteFailure: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  bookPlace: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import {
  CapabilityError,
  invalidateLibraryLists,
  qk,
  useAddLibrivox,
  useCancelBridgeJob,
  useLibrivoxJob,
  useLibrivoxSearch,
  useLibrivoxWork,
} from '@/api/hooks';
import { BRIDGE_IDLE_POLL_MS, LIBRIVOX_POLL_MS } from '@/lib/bridge-jobs';
import { driveAppState } from '@/testing/app-state';
import { librivoxJob, librivoxServer } from '@/testing/librivox-fixtures';
/* eslint-enable import/first */

notifyQueriesSynchronously();
const app = driveAppState();

const queryClients: QueryClient[] = [];

async function mount<T>(
  server: ServerInfo,
  useHooks: () => T,
  setup?: (client: ReturnType<typeof makeClient>) => void,
) {
  mockClients.c1 = makeClient();
  mockClients.c1.serverInfo.mockResolvedValue(server);
  setup?.(mockClients.c1);
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
  return { ...(await renderHook(useHooks, { wrapper })), qc };
}

afterEach(() => {
  for (const qc of queryClients.splice(0)) qc.clear();
  jest.clearAllMocks();
});

const caps = librivoxServer().capabilities;
const metadataOff = librivoxServer({ capabilities: { ...caps, metadata: false } });
const bridgeOff = librivoxServer({ capabilities: { ...caps, bridge: false }, bridge: undefined });

describe('useLibrivoxSearch / useLibrivoxWork', () => {
  it('asks nothing of a server with metadata off', async () => {
    const { result } = await mount(metadataOff, () => ({
      search: useLibrivoxSearch('crow'),
      work: useLibrivoxWork('johnny'),
    }));
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(result.current.search.isPending).toBe(true);
    expect(mockClients.c1.librivoxSearch).not.toHaveBeenCalled();
    expect(mockClients.c1.librivoxWork).not.toHaveBeenCalled();
  });

  it('asks nothing for a blank query or no work', async () => {
    await mount(librivoxServer(), () => ({
      search: useLibrivoxSearch('   '),
      work: useLibrivoxWork(null),
    }));
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(mockClients.c1.librivoxSearch).not.toHaveBeenCalled();
    expect(mockClients.c1.librivoxWork).not.toHaveBeenCalled();
  });

  it('searches the trimmed query and reads the work', async () => {
    const { result } = await mount(
      librivoxServer(),
      () => ({ search: useLibrivoxSearch(' crow '), work: useLibrivoxWork('johnny') }),
      (c) => {
        c.librivoxSearch.mockResolvedValue({ results: [] });
        c.librivoxWork.mockResolvedValue({ work: {}, recordings: [] });
      },
    );
    await waitFor(() => expect(result.current.search.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.work.isSuccess).toBe(true));
    expect(mockClients.c1.librivoxSearch).toHaveBeenCalledWith('crow', {}, expect.anything());
    expect(mockClients.c1.librivoxWork).toHaveBeenCalledWith('johnny', expect.anything());
  });
});

describe('useLibrivoxJob', () => {
  const useJob = () => useLibrivoxJob(41, true);

  it('asks nothing with the Bridge off, or with no job to follow', async () => {
    await mount(librivoxServer(), () => useLibrivoxJob(undefined, true));
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(mockClients.c1.bridgeJob).not.toHaveBeenCalled();

    await mount(bridgeOff, () => useJob());
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(mockClients.c1.bridgeJob).not.toHaveBeenCalled();
  });

  type Interval = (q: Query<BridgeJob>) => number | false;
  /** The job read's poll interval now, as React Query asks it. */
  const intervalOf = (qc: QueryClient) => {
    const query = qc.getQueryCache().find({ queryKey: qk.bridgeJob('c1', 41) })!;
    const fn = query.observers[0].options.refetchInterval as Interval;
    return fn(query as unknown as Query<BridgeJob>);
  };

  it('polls an open job, slowly while parked, and stops once it ended', async () => {
    const { result, qc } = await mount(
      librivoxServer(),
      () => useJob(),
      (c) => c.bridgeJob.mockResolvedValue(librivoxJob({ state: 'running' })),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockClients.c1.bridgeJob).toHaveBeenCalledWith(41, expect.anything());
    expect(intervalOf(qc)).toBe(LIBRIVOX_POLL_MS);
    await act(async () => {
      qc.setQueryData(qk.bridgeJob('c1', 41), librivoxJob({ state: 'needs_attention' }));
    });
    expect(intervalOf(qc)).toBe(BRIDGE_IDLE_POLL_MS);
    await act(async () => {
      qc.setQueryData(qk.bridgeJob('c1', 41), librivoxJob({ state: 'done' }));
    });
    expect(intervalOf(qc)).toBe(false);
  });

  it('does not poll while the app is in the background', async () => {
    const { result, qc } = await mount(
      librivoxServer(),
      () => useJob(),
      (c) => c.bridgeJob.mockResolvedValue(librivoxJob({ state: 'running' })),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    app.becomes('background');
    try {
      expect(intervalOf(qc)).toBe(false);
    } finally {
      app.becomes('active');
    }
    expect(intervalOf(qc)).toBe(LIBRIVOX_POLL_MS);
  });

  it('never asks again once the job is gone (a 404)', async () => {
    const { result, qc } = await mount(
      librivoxServer(),
      () => useJob(),
      (c) => c.bridgeJob.mockRejectedValue(new ApiError(404, 'not found')),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(intervalOf(qc)).toBe(false);
    // Even with an open answer still cached from before it went.
    await act(async () => {
      qc.setQueryData(qk.bridgeJob('c1', 41), librivoxJob({ state: 'running' }));
    });
    const query = qc.getQueryCache().find({ queryKey: qk.bridgeJob('c1', 41) })!;
    query.setState({ error: new ApiError(404, 'not found') });
    expect(intervalOf(qc)).toBe(false);
  });
});

describe('useLibrivoxJob, a first read that failed', () => {
  /** The poll interval after a first read that failed with `error`. */
  async function intervalAfter(error: Error) {
    const { result, qc } = await mount(
      librivoxServer(),
      () => useLibrivoxJob(41, true),
      (c) => c.bridgeJob.mockRejectedValue(error),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    const query = qc.getQueryCache().find({ queryKey: qk.bridgeJob('c1', 41) })!;
    const fn = query.observers[0].options.refetchInterval as (q: typeof query) => number | false;
    return fn(query);
  }

  it('is asked again (nothing else would), at the slow pace', async () => {
    expect(await intervalAfter(new ApiError(500, 'boom'))).toBe(BRIDGE_IDLE_POLL_MS);
    expect(await intervalAfter(new TypeError('Network request failed'))).toBe(BRIDGE_IDLE_POLL_MS);
  });

  it('is not asked again after a refusal (signed out, not an admin any more)', async () => {
    expect(await intervalAfter(new ApiError(401, 'unauthorized'))).toBe(false);
    expect(await intervalAfter(new ApiError(403, 'forbidden'))).toBe(false);
  });
});

describe('useAddLibrivox', () => {
  const WORKS = qk.librivoxWork('c1', 'johnny');

  it("seeds the job's own read and asks the works again", async () => {
    const job = librivoxJob({ state: 'queued' });
    const { result, qc } = await mount(librivoxServer(), () => useAddLibrivox());
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    qc.setQueryData(WORKS, { work: {}, recordings: [] });
    mockClients.c1.librivoxFetch.mockResolvedValue({ job });
    await act(async () => {
      await expect(result.current.mutateAsync({ libraryId: 3, librivoxId: 192 })).resolves.toEqual({
        job,
      });
    });
    expect(mockClients.c1.librivoxFetch).toHaveBeenCalledWith(3, 192);
    expect(qc.getQueryData(qk.bridgeJob('c1', 41))).toEqual(job);
    expect(qc.getQueryState(WORKS)?.isInvalidated).toBe(true);
  });

  it('asks the works again on a refusal too (an in_library shows where it is)', async () => {
    const { result, qc } = await mount(librivoxServer(), () => useAddLibrivox());
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    qc.setQueryData(WORKS, { work: {}, recordings: [] });
    mockClients.c1.librivoxFetch.mockRejectedValue(new ApiError(409, 'English', 'in_library'));
    await act(async () => {
      await expect(
        result.current.mutateAsync({ libraryId: 3, librivoxId: 192 }),
      ).rejects.toMatchObject({ code: 'in_library' });
    });
    expect(qc.getQueryState(WORKS)?.isInvalidated).toBe(true);
  });

  it('sends nothing with metadata off', async () => {
    const { result } = await mount(metadataOff, () => useAddLibrivox());
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    await act(async () => {
      await expect(
        result.current.mutateAsync({ libraryId: 3, librivoxId: 192 }),
      ).rejects.toBeInstanceOf(CapabilityError);
    });
    expect(mockClients.c1.librivoxFetch).not.toHaveBeenCalled();
  });
});

describe('useCancelBridgeJob, for a job about no book', () => {
  it("puts the answer into the job's own read, and reads it again on a refusal", async () => {
    const { result, qc } = await mount(librivoxServer(), () => useCancelBridgeJob());
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    const open = librivoxJob({ state: 'running' });
    const cancelled = librivoxJob({ state: 'cancelled' });
    mockClients.c1.cancelBridgeJob.mockResolvedValue(cancelled);
    await act(async () => {
      await result.current.mutateAsync(open);
    });
    expect(mockClients.c1.cancelBridgeJob).toHaveBeenCalledWith(41);
    expect(qc.getQueryData(qk.bridgeJob('c1', 41))).toEqual(cancelled);

    mockClients.c1.cancelBridgeJob.mockRejectedValue(new ApiError(409, 'done', 'finished'));
    await act(async () => {
      await expect(result.current.mutateAsync(open)).rejects.toBeInstanceOf(ApiError);
    });
    expect(qc.getQueryState(qk.bridgeJob('c1', 41))?.isInvalidated).toBe(true);
  });
});

describe('invalidateLibraryLists', () => {
  it("reads one library's books, folders, people and series and the recently added again, and nothing else", async () => {
    const qc = new QueryClient();
    queryClients.push(qc);
    const books = qk.libraryBooks('c1', 3, { sort: 'recent' });
    const series = qk.seriesList('c1', 3, true);
    const authors = qk.authors('c1', 3);
    const narrators = qk.narrators('c1', 3);
    const folder = qk.browse('c1', 3, 'L. Leslie Brooke');
    const recent = qk.recent('c1', 12);
    const other = qk.libraryBooks('c1', 4, { sort: 'recent' });
    const otherFolder = qk.browse('c1', 4, '');
    const otherServer = qk.libraryBooks('c2', 3, { sort: 'recent' });
    const otherRecent = qk.recent('c2', 12);
    const elsewhere = [other, otherFolder, otherServer, otherRecent];
    for (const key of [books, series, authors, narrators, folder, recent, ...elsewhere]) {
      qc.setQueryData(key, []);
    }
    invalidateLibraryLists(qc, 'c1', 3);
    for (const key of [books, series, authors, narrators, folder, recent]) {
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
    for (const key of elsewhere) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
  });
});
