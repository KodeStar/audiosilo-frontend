import { QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

import type { Capabilities, MyPodcasts, PodcastRequest, ServerInfo } from '@/api/types';
import { podcastShow } from '@/testing/podcast-fixtures';
import { golden2c3 } from '@/testing/podcast-fixtures-2c3';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// Finding shows (Bridge Phase 2d-2): the directory hooks ask only a server with
// `podcast_discovery`, follow by address and Check are `podcasts`' writes, the export is
// `podcast_opml`'s, and the follow requests poll only while one is open on a focused
// surface. The provider resolves each connection id to its own stub client (no id = 'c1').
function makeClient() {
  return {
    serverInfo: jest.fn(),
    podcastDiscoveryProviders: jest.fn(async () => golden2c3.wire.providers),
    searchPodcastDirectory: jest.fn(async () => golden2c3.itunes),
    followPodcastByUrl: jest.fn(),
    checkPodcast: jest.fn(async () => ({ request: { id: 3, state: 'queued' } })),
    exportOpml: jest.fn(async () => ({
      text: '<opml/>',
      exported: 1,
      omittedPrivate: 0,
      omittedUnavailable: 0,
    })),
    myPodcasts: jest.fn(async (): Promise<MyPodcasts> => ({ shows: [], requests: [] })),
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
  CapabilityError,
  qk,
  useCapability,
  useCheckPodcast,
  useExportOpml,
  useFollowPodcastByUrl,
  useFollowRequests,
  usePodcastDiscoveryProviders,
  usePodcastSearch,
  type PodcastSearchParams,
} from '@/api/hooks';
/* eslint-enable import/first */

function serverWith(caps: Partial<Capabilities>): ServerInfo {
  return {
    name: 'S',
    server_id: 's1',
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

function request(over: Partial<PodcastRequest> = {}): PodcastRequest {
  return {
    id: 81,
    library_id: 5,
    state: 'queued',
    feed: 'https://feeds.example.org/...',
    private: false,
    show_path: null,
    error: null,
    created_at: '2026-10-20T08:00:00Z',
    updated_at: '2026-10-20T08:00:00Z',
    ...over,
  };
}

notifyQueriesSynchronously();

const queryClients: QueryClient[] = [];

async function mount<P, T>(
  caps: Partial<Capabilities>,
  useHooks: (props: P) => T,
  initialProps?: P,
  setup?: (client: ReturnType<typeof makeClient>) => void,
) {
  mockClients.c1 = makeClient();
  mockClients.c1.serverInfo.mockResolvedValue(serverWith(caps));
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
  return { ...(await renderHook(useHooks, { wrapper, initialProps })), qc };
}

afterEach(() => {
  for (const qc of queryClients.splice(0)) qc.clear();
  for (const id of Object.keys(mockClients)) delete mockClients[id];
  jest.clearAllMocks();
});

const search: PodcastSearchParams = {
  q: 'fixture show',
  provider: 'itunes',
  country: 'GB',
  limit: 20,
};

describe('directory search hooks', () => {
  it('ask nothing of a server without podcast_discovery', async () => {
    const { result } = await mount({ podcasts: true }, () => ({
      providers: usePodcastDiscoveryProviders(),
      search: usePodcastSearch(search),
      known: useCapability('podcast_discovery'),
    }));
    await waitFor(() => expect(result.current.known).toBe(false));
    expect(mockClients.c1.podcastDiscoveryProviders).not.toHaveBeenCalled();
    expect(mockClients.c1.searchPodcastDirectory).not.toHaveBeenCalled();
  });

  it('read the providers and search only once submitted', async () => {
    const { result, rerender } = await mount(
      { podcast_discovery: true },
      (p: { params: PodcastSearchParams | null }) => ({
        providers: usePodcastDiscoveryProviders(),
        search: usePodcastSearch(p.params),
      }),
      { params: null as PodcastSearchParams | null },
    );
    await waitFor(() => expect(result.current.providers.data).toEqual(golden2c3.wire.providers));
    expect(mockClients.c1.searchPodcastDirectory).not.toHaveBeenCalled();
    await rerender({ params: search });
    await waitFor(() => expect(result.current.search.data).toEqual(golden2c3.itunes));
    expect(mockClients.c1.searchPodcastDirectory).toHaveBeenCalledTimes(1);
    expect(mockClients.c1.searchPodcastDirectory).toHaveBeenCalledWith(
      { q: 'fixture show', provider: 'itunes', country: 'GB', limit: 20 },
      expect.anything(),
    );
    // The same search again (a new object, as a submit makes) is held: nothing is asked.
    await rerender({ params: null });
    await rerender({ params: { ...search } });
    expect(result.current.search.data).toEqual(golden2c3.itunes);
    expect(mockClients.c1.searchPodcastDirectory).toHaveBeenCalledTimes(1);
    // Another provider is another search, with no country.
    await rerender({ params: { ...search, provider: 'podcast_index', country: null } });
    await waitFor(() => expect(mockClients.c1.searchPodcastDirectory).toHaveBeenCalledTimes(2));
    expect(mockClients.c1.searchPodcastDirectory).toHaveBeenLastCalledWith(
      { q: 'fixture show', provider: 'podcast_index', country: undefined, limit: 20 },
      expect.anything(),
    );
  });

  it('never retry a refused search', async () => {
    const { result } = await mount(
      { podcast_discovery: true },
      () => usePodcastSearch(search),
      undefined,
      (c) => c.searchPodcastDirectory.mockRejectedValue(new Error('429')),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockClients.c1.searchPodcastDirectory).toHaveBeenCalledTimes(1);
  });
});

describe('follow by address', () => {
  it('rejects with a CapabilityError, sending nothing, without podcasts', async () => {
    const { result } = await mount({ podcast_discovery: true }, () => ({
      m: useFollowPodcastByUrl(),
      known: useCapability('podcasts'),
    }));
    await waitFor(() => expect(result.current.known).toBe(false));
    let error: unknown;
    await act(async () => {
      await result.current.m
        .mutateAsync({ libraryId: 5, feedUrl: 'https://f/x' })
        .catch((e: unknown) => (error = e));
    });
    expect(error).toBeInstanceOf(CapabilityError);
    expect(mockClients.c1.followPodcastByUrl).not.toHaveBeenCalled();
  });

  it('puts a 200 show into the cached show list and reads the followed shows again', async () => {
    const { result, qc } = await mount({ podcasts: true }, () => ({
      m: useFollowPodcastByUrl(),
      known: useCapability('podcasts'),
    }));
    await waitFor(() => expect(result.current.known).toBe(true));
    const show = podcastShow({ following: false });
    qc.setQueryData(qk.podcastShows('c1', 5), [show]);
    qc.setQueryData(qk.myPodcasts('c1'), { shows: [], requests: [] });
    mockClients.c1.followPodcastByUrl.mockResolvedValue({
      state: 'following',
      show: { ...show, following: true },
    });
    await act(async () => {
      await result.current.m.mutateAsync({ libraryId: 5, feedUrl: 'https://f/x', private: true });
    });
    expect(mockClients.c1.followPodcastByUrl).toHaveBeenCalledWith(5, 'https://f/x', {
      private: true,
    });
    expect(qc.getQueryData(qk.podcastShows('c1', 5))).toEqual([{ ...show, following: true }]);
    expect(qc.getQueryState(qk.myPodcasts('c1'))?.isInvalidated).toBe(true);
  });

  it('reads the show list again when a 200 show is not in it', async () => {
    const { result, qc } = await mount({ podcasts: true }, () => ({
      m: useFollowPodcastByUrl(),
      known: useCapability('podcasts'),
    }));
    await waitFor(() => expect(result.current.known).toBe(true));
    qc.setQueryData(qk.podcastShows('c1', 5), [podcastShow({ path: 'Other' })]);
    mockClients.c1.followPodcastByUrl.mockResolvedValue({
      state: 'following',
      show: podcastShow(),
    });
    await act(async () => {
      await result.current.m.mutateAsync({ libraryId: 5, feedUrl: 'https://f/x' });
    });
    expect(qc.getQueryState(qk.podcastShows('c1', 5))?.isInvalidated).toBe(true);
  });

  it('puts a 202 request at the head of the cached follow requests', async () => {
    const { result, qc } = await mount({ podcasts: true }, () => ({
      m: useFollowPodcastByUrl(),
      known: useCapability('podcasts'),
    }));
    await waitFor(() => expect(result.current.known).toBe(true));
    const old = request({ id: 70, state: 'done' });
    qc.setQueryData(qk.myPodcasts('c1'), { shows: [], requests: [old] });
    const fresh = request({ id: 82 });
    mockClients.c1.followPodcastByUrl.mockResolvedValue({ state: 'subscribing', request: fresh });
    await act(async () => {
      await result.current.m.mutateAsync({ libraryId: 5, feedUrl: 'https://f/x' });
    });
    expect(qc.getQueryData(qk.myPodcasts('c1'))).toEqual({ shows: [], requests: [fresh, old] });
  });
});

describe('check, export', () => {
  it('check is the podcasts module write', async () => {
    const off = await mount({}, () => ({ m: useCheckPodcast(), known: useCapability('podcasts') }));
    await waitFor(() => expect(off.result.current.known).toBe(false));
    let error: unknown;
    await act(async () => {
      await off.result.current.m
        .mutateAsync({ libraryId: 5, path: 'S' })
        .catch((e: unknown) => (error = e));
    });
    expect(error).toBeInstanceOf(CapabilityError);
    expect(mockClients.c1.checkPodcast).not.toHaveBeenCalled();

    const on = await mount({ podcasts: true }, () => ({
      m: useCheckPodcast(),
      known: useCapability('podcasts'),
    }));
    await waitFor(() => expect(on.result.current.known).toBe(true));
    await act(async () => {
      await on.result.current.m.mutateAsync({ libraryId: 5, path: 'Daily News' });
    });
    expect(mockClients.c1.checkPodcast).toHaveBeenCalledWith(5, 'Daily News');
  });

  it('export is podcast_opml, not the module', async () => {
    const off = await mount({ podcasts: true }, () => ({
      m: useExportOpml(),
      known: useCapability('podcast_opml'),
    }));
    await waitFor(() => expect(off.result.current.known).toBe(false));
    let error: unknown;
    await act(async () => {
      await off.result.current.m.mutateAsync().catch((e: unknown) => (error = e));
    });
    expect(error).toMatchObject({ capability: 'podcast_opml' });

    const on = await mount({ podcasts: false, podcast_opml: true }, () => ({
      m: useExportOpml(),
      known: useCapability('podcast_opml'),
    }));
    await waitFor(() => expect(on.result.current.known).toBe(true));
    let answer: unknown;
    await act(async () => {
      answer = await on.result.current.m.mutateAsync();
    });
    expect(answer).toMatchObject({ text: '<opml/>', exported: 1 });
  });
});

describe('useFollowRequests', () => {
  const original = AppState.currentState;
  afterEach(() => {
    (AppState as { currentState: string }).currentState = original;
  });

  type Interval = (q: Query<MyPodcasts>) => number | false;
  const intervalOf = (qc: QueryClient) => {
    const query = qc.getQueryCache().find({ queryKey: qk.myPodcasts('c1') })!;
    const fn = query.observers[0].options.refetchInterval as Interval;
    return () => fn(query as unknown as Query<MyPodcasts>);
  };

  it("lists this library's requests, open first, newest first", async () => {
    const answer = {
      shows: [],
      requests: [
        request({ id: 1, state: 'done', created_at: '2026-10-22T08:00:00Z' }),
        request({ id: 2, state: 'queued', created_at: '2026-10-20T08:00:00Z' }),
        request({ id: 3, state: 'running', created_at: '2026-10-21T08:00:00Z' }),
        request({ id: 4, library_id: 9, state: 'queued' }),
        request({ id: 5, state: 'failed', created_at: '2026-10-23T08:00:00Z' }),
      ],
    };
    const { result } = await mount(
      {},
      () => useFollowRequests(5, { active: true }),
      undefined,
      (c) => c.myPodcasts.mockResolvedValue(answer),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((r) => r.id)).toEqual([3, 2, 5, 1]);
  });

  it('polls only while one is open, the surface active and the app in front', async () => {
    (AppState as { currentState: string }).currentState = 'active';
    const { result, qc, rerender } = await mount(
      {},
      (p: { active: boolean }) => useFollowRequests(5, { active: p.active }),
      { active: true },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(intervalOf(qc)()).toBe(false);

    qc.setQueryData(qk.myPodcasts('c1'), { shows: [], requests: [request()] });
    expect(intervalOf(qc)()).toBe(5_000);
    // Another library's open request does not keep this one polling.
    qc.setQueryData(qk.myPodcasts('c1'), {
      shows: [],
      requests: [request({ library_id: 9 }), request({ id: 2, state: 'done' })],
    });
    expect(intervalOf(qc)()).toBe(false);

    qc.setQueryData(qk.myPodcasts('c1'), { shows: [], requests: [request()] });
    (AppState as { currentState: string }).currentState = 'background';
    expect(intervalOf(qc)()).toBe(false);
    (AppState as { currentState: string }).currentState = 'active';
    await rerender({ active: false });
    expect(intervalOf(qc)()).toBe(false);
  });

  it("reads a library's shows again once a request it saw open ends done", async () => {
    const { result, qc } = await mount({}, () => useFollowRequests(5, { active: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    qc.setQueryData(qk.podcastShows('c1', 5), [podcastShow()]);
    qc.setQueryData(qk.podcastShows('c1', 9), [podcastShow()]);
    qc.setQueryData(qk.myPodcasts('c1'), {
      shows: [],
      requests: [request({ id: 1 }), request({ id: 2, library_id: 9, state: 'failed' })],
    });
    mockClients.c1.myPodcasts.mockResolvedValue({
      shows: [],
      requests: [
        request({ id: 1, state: 'done' }),
        request({ id: 2, library_id: 9, state: 'failed' }),
      ],
    });
    await act(async () => {
      await result.current.refetch();
    });
    expect(qc.getQueryState(qk.podcastShows('c1', 5))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.podcastShows('c1', 9))?.isInvalidated).toBe(false);
    // Polling stops: nothing is open.
    expect(intervalOf(qc)()).toBe(false);
  });
});
