import { QueryObserver } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';

import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { setAddressPick, useAddressRoute } from './address-route';
import { ApiError, TimeoutError } from './client';
import { qk } from './hooks';
import { noteSuccess, useReachability } from './reachability';
import {
  type ApiConnection,
  ApiProvider,
  buildClients,
  queryClient,
  retryQuery,
  useApis,
} from './provider';

// The provider's reconnect handler, as the reachability layer would run it (registered
// while the provider is imported, so no initializer here that would reset it after).
let mockReconnect: ((cid: string) => void) | undefined;
jest.mock('./reachability', () => ({
  ...jest.requireActual('./reachability'),
  onReconnect: (cb: (cid: string) => void) => {
    mockReconnect = cb;
    return () => {};
  },
  setReachabilityClients: jest.fn(),
}));

const seen: ApiConnection[][] = [];

/** Hands every render's `useApis()` to `onApis`; `tick` only re-renders it. */
function Reader({ onApis }: { tick: number; onApis: (apis: ApiConnection[]) => void }) {
  onApis(useApis());
  return null;
}
const ui = (tick: number) => (
  <ApiProvider>
    <Reader tick={tick} onApis={(apis) => seen.push(apis)} />
  </ApiProvider>
);

describe('useApis', () => {
  // Callers memoise on it (the Journal's per-server queries, their merge): a new array on
  // every render would rebuild them all for nothing.
  it('is the same array across renders while the connections are, a new one when they change', async () => {
    useSession.setState({
      connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'https://h', token: 't' }],
    } as never);
    const view = await render(ui(0));
    await view.rerender(ui(1));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(seen[0]);
    expect(seen[0].map((a) => a.connection.id)).toEqual(['c1']);

    await act(async () =>
      useSession.setState({
        connections: [
          { id: 'c1', name: 'Hearthside', serverUrl: 'https://h', token: 't' },
          { id: 'c2', name: 'Maya', serverUrl: 'https://m', token: 't' },
        ],
      } as never),
    );
    expect(seen.at(-1)).not.toBe(seen[0]);
    expect(seen.at(-1)!.map((a) => a.connection.id)).toEqual(['c1', 'c2']);
  });
});

describe('useApis and the people on this device (Phase 8)', () => {
  beforeEach(() => resetProfilesForTests());

  // Every aggregated screen (Home, Search and the palette, the Library picker, You, the
  // Journal) reads its servers here: another person's must never be among them.
  it("is the person listening's connections only, and follows a switch", async () => {
    seen.length = 0;
    useSession.setState({
      connections: [
        { id: 'a.1', name: 'Hearthside', serverUrl: 'https://h', token: 't' },
        { id: 'a.2', name: 'Hearthside', serverUrl: 'https://h', token: 'u' },
        { id: 'b.1', name: 'Maya', serverUrl: 'https://m', token: 't' },
      ],
    } as never);
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'chris', name: 'Chris', connectionIds: ['a.1', 'b.1'] },
        { id: 'sam', name: 'Sam', connectionIds: ['a.2'] },
      ],
      activeProfileId: 'chris',
    });
    await render(ui(0));
    expect(seen.at(-1)!.map((a) => a.connection.id)).toEqual(['a.1', 'b.1']);
    await act(async () => useProfiles.setState({ activeProfileId: 'sam' }));
    expect(seen.at(-1)!.map((a) => a.connection.id)).toEqual(['a.2']);
  });
});

describe('ApiProvider clients', () => {
  beforeEach(() => resetProfilesForTests());

  // A switch between a server's home and away address must reach every request the
  // provider's clients make (queries, mutations, media URLs).
  it('rebuilds a connection client on the address the player picked', async () => {
    const home = 'http://192.168.1.20:8080';
    useSession.setState({
      connections: [
        {
          id: 'c1',
          name: 'Hearthside',
          serverUrl: 'https://h',
          token: 't',
          addresses: { home, away: 'https://h' },
        },
      ],
    } as never);
    seen.length = 0;
    await render(ui(0));
    expect(seen.at(-1)![0].client.baseUrl).toBe('https://h');
    await act(async () => setAddressPick('c1', home));
    expect(seen.at(-1)![0].client.baseUrl).toBe(home);
    await act(async () => useAddressRoute.setState({ picks: {} }));
    expect(seen.at(-1)![0].client.baseUrl).toBe('https://h');
  });
});

describe('buildClients', () => {
  const home = 'http://192.168.1.20:8080';
  const conns = [
    { id: 'c1', serverUrl: 'https://h', token: 't', addresses: { home, away: 'https://h' } },
    { id: 'c2', serverUrl: 'https://m', token: 't' },
  ] as never[];

  it('rebuilds only the client whose address or token moved', () => {
    const first = buildClients(conns, {}, new Map());
    const switched = buildClients(conns, { c1: home }, first);
    expect(switched.get('c1')!.client).not.toBe(first.get('c1')!.client);
    expect(switched.get('c1')!.client.baseUrl).toBe(home);
    expect(switched.get('c2')!.client).toBe(first.get('c2')!.client);
    const repaired = buildClients(
      [conns[0], { ...(conns[1] as object), token: 'fresh' }] as never[],
      { c1: home },
      switched,
    );
    expect(repaired.get('c1')!.client).toBe(switched.get('c1')!.client);
    expect(repaired.get('c2')!.client).not.toBe(switched.get('c2')!.client);
  });

  it('drops a removed connection', () => {
    const first = buildClients(conns, {}, new Map());
    expect([...buildClients([conns[0]], {}, first).keys()]).toEqual(['c1']);
  });
});

describe('the query cache with `<server_id>.<user_id>` connection ids', () => {
  it('a removed connection evicts its own queries, never another user of the same server', async () => {
    const user = (id: number) => ({
      id,
      username: `u${id}`,
      role: 'user' as const,
      disabled: false,
      has_password: true,
      has_recovery: false,
    });
    useSession.setState({ connections: [], defaultConnectionId: null } as never);
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://h', serverId: 'srv', token: 'a', user: user(3) });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://h', serverId: 'srv', token: 'b', user: user(30) });
    queryClient.setQueryData(qk.libraries('srv.3'), [1]);
    queryClient.setQueryData(qk.libraries('srv.30'), [2]);
    await useSession.getState().removeConnection('srv.3');
    expect(queryClient.getQueryData(qk.libraries('srv.3'))).toBeUndefined();
    expect(queryClient.getQueryData(qk.libraries('srv.30'))).toEqual([2]);
  });

  it("a /server answer from the connection's own server flags nothing; another server_id flags it", async () => {
    useSession.setState({
      connections: [
        { id: 'srv.3', serverId: 'srv', name: 'H', serverUrl: 'https://h', token: 't' },
      ],
    } as never);
    await queryClient.fetchQuery({
      queryKey: qk.server('srv.3'),
      queryFn: async () => ({ server_id: 'srv' }),
    });
    expect(useSession.getState().connections[0].needsReconnect).toBeUndefined();
    await queryClient.fetchQuery({
      queryKey: qk.server('srv.3'),
      queryFn: async () => ({ server_id: 'rebuilt' }),
      staleTime: 0,
    });
    expect(useSession.getState().connections[0].needsReconnect).toBe('server-reset');
  });
});

describe('a connection signed in again (a new token, 8b-1)', () => {
  it('reads again what failed and the lists screens read first, for that connection only', async () => {
    const at = (id: string, token: string) => ({
      id,
      serverId: 'srv',
      name: 'H',
      serverUrl: 'https://h',
      token,
    });
    useSession.setState({ connections: [at('srv.3', 'dead'), at('srv.1', 't')] } as never);
    await render(ui(0));
    queryClient.setQueryData(qk.libraries('srv.3'), [{ id: 4 }]);
    queryClient.setQueryData(qk.libraries('srv.1'), [{ id: 4 }]);
    queryClient.setQueryData(qk.allProgress('srv.3'), []);
    // Asked while signed out: a 401.
    await queryClient
      .fetchQuery({
        queryKey: qk.libraryBooks('srv.3', 4, {}),
        queryFn: async () => {
          throw new Error('401');
        },
      })
      .catch(() => undefined);
    const stale = (key: readonly unknown[]) =>
      queryClient.getQueryState(key)?.isInvalidated === true;
    expect(stale(qk.libraries('srv.3'))).toBe(false);

    await act(async () =>
      useSession.setState({ connections: [at('srv.3', 'fresh'), at('srv.1', 't')] } as never),
    );
    expect(stale(qk.libraries('srv.3'))).toBe(true);
    expect(stale(qk.libraryBooks('srv.3', 4, {}))).toBe(true);
    // An answer that was fine stays, and another connection is left alone.
    expect(stale(qk.allProgress('srv.3'))).toBe(false);
    expect(stale(qk.libraries('srv.1'))).toBe(false);
  });

  it('reads nothing again for a connection that is new, or whose token stayed', async () => {
    const c = { id: 'srv.5', serverId: 'srv', name: 'H', serverUrl: 'https://h', token: 't' };
    useSession.setState({ connections: [] } as never);
    await render(ui(0));
    queryClient.setQueryData(qk.libraries('srv.5'), [{ id: 4 }]);
    await act(async () => useSession.setState({ connections: [c] } as never));
    await act(async () =>
      useSession.setState({ connections: [{ ...c, name: 'Renamed' }] } as never),
    );
    expect(queryClient.getQueryState(qk.libraries('srv.5'))?.isInvalidated).toBe(false);
  });
});

// frontend#124: a refused token stays refused, so a 401 is never asked again.
describe('the default query retry', () => {
  it('is the default for every query', () => {
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(retryQuery);
  });

  it('tries once more after a failure that may pass', () => {
    expect(retryQuery(0, new ApiError(500, 'down'))).toBe(true);
    expect(retryQuery(0, new TimeoutError(1000))).toBe(true);
    expect(retryQuery(0, new Error('offline'))).toBe(true);
    expect(retryQuery(1, new ApiError(500, 'down'))).toBe(false);
  });

  it('never retries a 401', () => {
    expect(retryQuery(0, new ApiError(401, 'unauthorized'))).toBe(false);
  });
});

// frontend#131: a query that got no answer marks its server unreachable, so the chrome
// names it and its screens refetch once it is back.
describe('queries and reachability', () => {
  beforeEach(() => {
    useReachability.setState({ online: {} });
    useSession.setState({
      connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'https://h', token: 't' }],
    } as never);
    queryClient.clear();
  });
  // Back online, so the reachability probe a test started stops.
  afterEach(() => noteSuccess('c1'));

  const fail = (error: unknown, key = qk.libraries('c1')) =>
    queryClient
      .fetchQuery({ queryKey: key, queryFn: () => Promise.reject(error), retry: false })
      .catch(() => {});

  it('marks a server unreachable when a query got no answer', async () => {
    await fail(new TypeError('Failed to fetch'));
    expect(useReachability.getState().online.c1).toBe(false);
  });

  it('never for an answer, a cancel or a capability gate', async () => {
    await fail(new ApiError(500, 'down'));
    await fail(new ApiError(401, 'unauthorized'));
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    await fail(abort);
    await fail(new Error('This server does not support queue'));
    expect(useReachability.getState().online.c1).toBeUndefined();
  });

  it('refetches a failed list once its server is back, and an answer brings it back', async () => {
    const libraries = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    const observer = new QueryObserver(queryClient, {
      queryKey: qk.libraries('c1'),
      queryFn: libraries,
      retry: false,
    });
    const stop = observer.subscribe(() => {});
    try {
      await waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
      expect(useReachability.getState().online.c1).toBe(false);
      libraries.mockResolvedValue([{ id: 1 }]);
      // The probe found it answering: the provider's reconnect handler refetches.
      mockReconnect?.('c1');
      await waitFor(() => expect(observer.getCurrentResult().data).toEqual([{ id: 1 }]));
      expect(useReachability.getState().online.c1).toBe(true);
    } finally {
      stop();
    }
  });
});
