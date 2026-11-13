import { type Query, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { ApiError } from '@/api/client';
import type { BridgeJob, ServerInfo } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// The LibriVox hooks (LibriVox L6): the reads ask only while the page's gate lets them
// (`allowed`) and only a server with the flag (`metadata` for the catalogue, `bridge` for
// the job); an Add seeds the job's own read and asks the works again whatever the answer; a
// job is polled while open and never again once it is gone.
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
  useCancelLibrivoxJob,
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
  it('asks nothing while the page does not let it, or of a server with metadata off', async () => {
    const a = await mount(librivoxServer(), () => ({
      search: useLibrivoxSearch('crow', false),
      work: useLibrivoxWork('johnny', false),
    }));
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(a.result.current.search.isPending).toBe(true);
    expect(mockClients.c1.librivoxSearch).not.toHaveBeenCalled();
    expect(mockClients.c1.librivoxWork).not.toHaveBeenCalled();

    await mount(metadataOff, () => ({
      search: useLibrivoxSearch('crow', true),
      work: useLibrivoxWork('johnny', true),
    }));
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(mockClients.c1.librivoxSearch).not.toHaveBeenCalled();
    expect(mockClients.c1.librivoxWork).not.toHaveBeenCalled();
  });

  it('asks nothing for a blank query or no work', async () => {
    await mount(librivoxServer(), () => ({
      search: useLibrivoxSearch('   ', true),
      work: useLibrivoxWork(null, true),
    }));
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(mockClients.c1.librivoxSearch).not.toHaveBeenCalled();
    expect(mockClients.c1.librivoxWork).not.toHaveBeenCalled();
  });

  it('searches the trimmed query and reads the work when allowed', async () => {
    const { result } = await mount(
      librivoxServer(),
      () => ({ search: useLibrivoxSearch(' crow ', true), work: useLibrivoxWork('johnny', true) }),
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
  const useJob = (allowed = true) => useLibrivoxJob(41, { allowed, active: true });

  it('asks nothing while the page does not let it, or with the Bridge off', async () => {
    await mount(librivoxServer(), () => useJob(false));
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

describe('useCancelLibrivoxJob', () => {
  it("puts the answer into the job's read, and reads it again on a refusal", async () => {
    const { result, qc } = await mount(librivoxServer(), () => useCancelLibrivoxJob());
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    const cancelled = librivoxJob({ state: 'cancelled' });
    mockClients.c1.cancelBridgeJob.mockResolvedValue(cancelled);
    await act(async () => {
      await result.current.mutateAsync(41);
    });
    expect(mockClients.c1.cancelBridgeJob).toHaveBeenCalledWith(41);
    expect(qc.getQueryData(qk.bridgeJob('c1', 41))).toEqual(cancelled);

    mockClients.c1.cancelBridgeJob.mockRejectedValue(new ApiError(409, 'done', 'finished'));
    await act(async () => {
      await expect(result.current.mutateAsync(41)).rejects.toBeInstanceOf(ApiError);
    });
    expect(qc.getQueryState(qk.bridgeJob('c1', 41))?.isInvalidated).toBe(true);
  });
});

describe('invalidateLibraryLists', () => {
  it("reads one library's books, people and series again, and nothing else", async () => {
    const qc = new QueryClient();
    queryClients.push(qc);
    const books = qk.libraryBooks('c1', 3, { sort: 'recent' });
    const series = qk.seriesList('c1', 3, true);
    const authors = qk.authors('c1', 3);
    const narrators = qk.narrators('c1', 3);
    const other = qk.libraryBooks('c1', 4, { sort: 'recent' });
    const otherServer = qk.libraryBooks('c2', 3, { sort: 'recent' });
    for (const key of [books, series, authors, narrators, other, otherServer]) {
      qc.setQueryData(key, []);
    }
    invalidateLibraryLists(qc, 'c1', 3);
    for (const key of [books, series, authors, narrators]) {
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(qc.getQueryState(other)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(otherServer)?.isInvalidated).toBe(false);
  });
});
