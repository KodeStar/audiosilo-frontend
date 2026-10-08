import { AppState, type AppStateStatus, Platform } from 'react-native';

import type { NowPlaying } from '@/playback/store';
import { type Connection, useSession } from '@/stores/session';

// The player store is reduced to what the runner reads (the real one brings the engine).
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({
      nowPlaying: null,
      snapshot: { state: 'idle', position: 0, trackIndex: 0 },
      rate: 1,
      loadingBook: null,
    })),
    selectBookPosition: (s: { nowPlaying: unknown; snapshot: { position: number } }) =>
      s.nowPlaying ? s.snapshot.position : 0,
  };
});
jest.mock('@/components/player/start-book', () => ({
  startBookInPlace: jest.fn(async () => true),
}));
type MockNetwork = { type?: string; isConnected?: boolean };
let mockNetworkListener: ((state: MockNetwork) => void) | null = null;
let mockNetwork: MockNetwork = { type: 'WIFI', isConnected: true };
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => mockNetwork,
  addNetworkStateListener: (listener: (state: MockNetwork) => void) => {
    mockNetworkListener = listener;
    return {
      remove: () => {
        mockNetworkListener = null;
      },
    };
  },
}));
// The reads the runner makes through the query cache go straight to the client here, so
// every request is a real ApiClient request on the fake fetch below.
jest.mock('@/api/hooks', () => ({
  addressesQuery: (cid: string, client: { addresses: () => Promise<unknown> }) => ({
    queryKey: ['addresses', cid],
    queryFn: () => client.addresses(),
  }),
  fetchFailFast: (o: { queryFn: () => Promise<unknown> }) => o.queryFn(),
  fetchCapabilities: async (_cid: string, client: { serverInfo: () => Promise<any> }) =>
    (await client.serverInfo()).capabilities,
}));

/* eslint-disable import/first */
import { useAddressRoute } from '@/api/address-route';
import {
  followPlayingBook,
  HOME_RECHECK_MS,
  NETWORK_SETTLE_MS,
  refreshAddresses,
  repick,
  startAddressRouting,
} from '@/api/address-runner';
import { resolveClient } from '@/api/connection-clients';
import { noteSuccess, useReachability } from '@/api/reachability';
import { probeServerId } from '@/api/server-id-probe';
import { startBookInPlace } from '@/components/player/start-book';
import { usePlayer } from '@/playback/store';
/* eslint-enable import/first */

const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';

type Server = { id: string; addresses?: boolean; answer?: { home?: string; away?: string } };
/** Which server answers at each address (absent = unreachable). */
let servers: Record<string, Server> = {};
let fetchMock: jest.Mock;

function installFetch() {
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const base = Object.keys(servers).find((b) => url.startsWith(`${b}/api/v1/`));
    if (!base) throw new TypeError('Network request failed');
    const server = servers[base];
    const path = url.slice(`${base}/api/v1`.length);
    const body =
      path === '/server'
        ? {
            name: 'S',
            server_id: server.id,
            version: '1',
            api: 'v1',
            capabilities: { addresses: !!server.addresses },
            auth: { methods: [] },
          }
        : path === '/addresses'
          ? (server.answer ?? {})
          : { id: 1 };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    } as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
}

/** Every request made to `base`: its path and Authorization header. */
function requestsTo(base: string) {
  return fetchMock.mock.calls
    .filter(([u]) => String(u).startsWith(base))
    .map(([u, init]) => ({
      path: String(u).slice(base.length),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    }));
}

const mkConn = (over: Partial<Connection> = {}): Connection =>
  ({
    id: 'srv-a',
    serverUrl: AWAY,
    name: 'Hearthside',
    token: 'secret',
    user: { id: 1, username: 'a', role: 'user', disabled: false },
    addresses: { home: HOME, away: AWAY },
    ...over,
  }) as Connection;

const setConnections = (connections: Connection[], status = 'authenticated') =>
  useSession.setState({ connections, status } as never);

const pickOf = (cid = 'srv-a') => useAddressRoute.getState().picks[cid];
/** The address the connection's requests go to now. */
const inUse = () => resolveClient('srv-a')!.baseUrl;

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(() => r()));
};

let appHandler: ((s: AppStateStatus) => void) | null = null;
let stop: (() => void) | null = null;

beforeEach(() => {
  servers = {};
  mockNetwork = { type: 'WIFI', isConnected: true };
  installFetch();
  jest.clearAllMocks();
  useAddressRoute.setState({ picks: {} });
  useReachability.setState({ online: {} });
  setConnections([]);
  usePlayer.setState({
    nowPlaying: null,
    snapshot: { state: 'idle', position: 0, trackIndex: 0 } as never,
    rate: 1,
    loadingBook: null,
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    appHandler = handler as (s: AppStateStatus) => void;
    return { remove: () => (appHandler = null) } as never;
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  jest.restoreAllMocks();
});

describe('picking the address', () => {
  it('uses home when it answers with this server_id, the token only after that', async () => {
    servers = { [HOME]: { id: 'srv-a' }, [AWAY]: { id: 'srv-a' } };
    setConnections([mkConn()]);
    await repick('srv-a');
    expect(pickOf()).toBe(HOME);
    // The probe carried no token; requests after the match go home WITH it.
    expect(requestsTo(HOME)).toEqual([{ path: '/api/v1/server', auth: undefined }]);
    await resolveClient('srv-a')!.me();
    expect(requestsTo(HOME).at(-1)).toEqual({ path: '/api/v1/me', auth: 'Bearer secret' });
  });

  it('never sends the token to a home address that answered as another server', async () => {
    // Someone else's box at the same private IP, on another network.
    servers = { [HOME]: { id: 'not-yours' }, [AWAY]: { id: 'srv-a' } };
    setConnections([mkConn({ serverUrl: HOME })]); // even when paired at that address
    await repick('srv-a');
    expect(pickOf()).toBe(AWAY);
    await resolveClient('srv-a')!.me();
    await resolveClient('srv-a')!.libraries();
    expect(requestsTo(HOME)).toEqual([{ path: '/api/v1/server', auth: undefined }]);
    expect(requestsTo(AWAY).every((r) => r.auth === 'Bearer secret')).toBe(true);
  });

  it('falls back to away, else the paired URL, when home does not answer', async () => {
    servers = { [AWAY]: { id: 'srv-a' } };
    setConnections([mkConn({ serverUrl: HOME })]);
    await repick('srv-a');
    expect(pickOf()).toBe(AWAY);
    setConnections([mkConn({ serverUrl: 'https://paired', addresses: { home: HOME } })]);
    await repick('srv-a');
    expect(pickOf()).toBeUndefined(); // the paired URL: no pick
    expect(resolveClient('srv-a')!.baseUrl).toBe('https://paired');
  });

  it('asks nothing for a connection without a home address', async () => {
    setConnections([mkConn({ addresses: { away: AWAY } })]);
    await repick('srv-a');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pickOf()).toBeUndefined();
  });

  it('lets the newest re-pick win over an older, slower probe', async () => {
    const answers: ((id: string | null) => void)[] = [];
    stop = startAddressRouting({
      probe: () => new Promise<string | null>((r) => answers.push(r)),
    });
    setConnections([mkConn()]);
    await flush();
    const older = repick('srv-a');
    const newer = repick('srv-a');
    answers.at(-1)!(null); // the newest: home is gone
    await newer;
    answers.forEach((answer) => answer('srv-a')); // the older ones answer late
    await older;
    await flush();
    expect(inUse()).toBe(AWAY);
  });

  it('the default probe asks /server without a token and reads its server_id', async () => {
    servers = { [HOME]: { id: 'srv-a' } };
    await expect(probeServerId(HOME)).resolves.toBe('srv-a');
    await expect(probeServerId('http://10.0.0.9')).resolves.toBeNull();
    expect(requestsTo(HOME)).toEqual([{ path: '/api/v1/server', auth: undefined }]);
  });
});

describe('when it re-picks', () => {
  it('at launch, once the session has loaded, then reads the addresses', async () => {
    servers = {
      [HOME]: { id: 'srv-a', addresses: true, answer: { home: HOME, away: AWAY } },
      [AWAY]: { id: 'srv-a', addresses: true },
    };
    setConnections([mkConn({ addresses: { home: HOME } })], 'loading');
    stop = startAddressRouting();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    useSession.setState({ status: 'authenticated' } as never);
    await flush();
    expect(pickOf()).toBe(HOME);
    // The addresses were read through the picked (home) address and kept.
    expect(requestsTo(HOME).map((r) => r.path)).toContain('/api/v1/addresses');
    expect(useSession.getState().connections[0].addresses).toEqual({ home: HOME, away: AWAY });
  });

  it('at once when the connection is marked offline', async () => {
    servers = { [HOME]: { id: 'srv-a' }, [AWAY]: { id: 'srv-a' } };
    setConnections([mkConn()]);
    stop = startAddressRouting();
    await flush();
    expect(pickOf()).toBe(HOME);
    delete servers[HOME]; // left home
    useReachability.setState({ online: { 'srv-a': false } });
    await flush();
    expect(inUse()).toBe(AWAY);
  });

  it('on a network change and when the app comes back to the foreground', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      servers = { [AWAY]: { id: 'srv-a' } };
      setConnections([mkConn()]);
      stop = startAddressRouting();
      await flush();
      expect(pickOf()).toBeUndefined();
      servers[HOME] = { id: 'srv-a' }; // arrived home
      mockNetworkListener!({ type: 'WIFI', isConnected: true });
      jest.advanceTimersByTime(NETWORK_SETTLE_MS);
      await flush();
      expect(pickOf()).toBe(HOME);
      delete servers[HOME];
      appHandler!('background');
      appHandler!('active');
      await flush();
      expect(pickOf()).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks home once for a burst of changes that keep the device where it is', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      const probe = jest.fn(async () => null);
      setConnections([mkConn()]);
      stop = startAddressRouting({ probe });
      await flush();
      expect(probe).toHaveBeenCalledTimes(1); // launch
      for (let i = 0; i < 4; i++) {
        mockNetworkListener!({ type: 'WIFI', isConnected: true });
        jest.advanceTimersByTime(NETWORK_SETTLE_MS / 2);
      }
      expect(probe).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(NETWORK_SETTLE_MS);
      await flush();
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops a home pick at once when the device moves to another network', async () => {
    servers = { [HOME]: { id: 'srv-a' }, [AWAY]: { id: 'srv-a' } };
    setConnections([mkConn()]);
    stop = startAddressRouting();
    await flush();
    expect(inUse()).toBe(HOME);
    // The same network changing (Android reports capability changes): no switch.
    mockNetworkListener!({ type: 'WIFI', isConnected: true });
    expect(inUse()).toBe(HOME);
    await flush();
    expect(inUse()).toBe(HOME);
    // Another network: away BEFORE anything is sent, so a request made now can't take the
    // token to a box at the same IP there; home is checked again and wins when it answers.
    mockNetworkListener!({ type: 'CELLULAR', isConnected: true });
    expect(inUse()).toBe(AWAY);
    await flush();
    expect(inUse()).toBe(HOME); // (here the same server still answers)
    // Losing the connection counts as a move too.
    delete servers[HOME];
    mockNetworkListener!({ type: 'NONE', isConnected: false });
    expect(inUse()).toBe(AWAY);
    await flush();
    expect(inUse()).toBe(AWAY);
  });

  it('drops a device paired at home to its away address on a move, and back', async () => {
    servers = { [HOME]: { id: 'srv-a' }, [AWAY]: { id: 'srv-a' } };
    setConnections([mkConn({ serverUrl: HOME })]);
    stop = startAddressRouting();
    await flush();
    expect(inUse()).toBe(HOME);
    delete servers[HOME];
    mockNetworkListener!({ type: 'CELLULAR', isConnected: true });
    expect(inUse()).toBe(AWAY);
    await flush();
    expect(inUse()).toBe(AWAY);
    // Back home: the foreground reads the network (a move) and checks home again.
    servers[HOME] = { id: 'srv-a' };
    mockNetwork = { type: 'WIFI', isConnected: true };
    appHandler!('background');
    appHandler!('active');
    await flush();
    expect(inUse()).toBe(HOME);
  });

  it('when a connection learns new addresses, and drops the pick of a removed one', async () => {
    servers = { [HOME]: { id: 'srv-a' } };
    setConnections([mkConn({ addresses: undefined })]);
    stop = startAddressRouting();
    await flush();
    expect(pickOf()).toBeUndefined();
    setConnections([mkConn()]);
    await flush();
    expect(pickOf()).toBe(HOME);
    setConnections([]);
    await flush();
    expect(useAddressRoute.getState().picks).toEqual({});
  });

  it('does nothing at all on web', async () => {
    const os = Platform.OS;
    Platform.OS = 'web';
    try {
      servers = { [HOME]: { id: 'srv-a' } };
      setConnections([mkConn()]);
      stop = startAddressRouting();
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockNetworkListener).toBeNull();
    } finally {
      Platform.OS = os;
    }
  });
});

describe('coming home without a trigger', () => {
  // Walking in the door raises no network event the runner hears (Wi-Fi joins, the app
  // stays open): the iPhone needed a foreground, the Pixel once stayed away for 60 s.
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** A probe whose answers the test releases, counting the home probes. */
  function heldProbe() {
    const calls: { url: string; answer: (id: string | null) => void }[] = [];
    const probe = (url: string) =>
      new Promise<string | null>((resolve) => calls.push({ url, answer: resolve }));
    return { calls, probe };
  }

  it('asks home again every so often in the foreground while away, and switches', async () => {
    const { calls, probe } = heldProbe();
    setConnections([mkConn()]);
    stop = startAddressRouting({ probe });
    await flush();
    expect(calls).toHaveLength(1); // launch
    calls[0].answer(null); // not home yet
    await flush();
    expect(inUse()).toBe(AWAY);
    jest.advanceTimersByTime(HOME_RECHECK_MS - 1);
    expect(calls).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(HOME);
    calls[1].answer('srv-a'); // home now
    await flush();
    expect(inUse()).toBe(HOME);
    // On home: nothing more to ask.
    jest.advanceTimersByTime(HOME_RECHECK_MS * 3);
    expect(calls).toHaveLength(2);
  });

  it('keeps one probe in flight per connection', async () => {
    const { calls, probe } = heldProbe();
    setConnections([mkConn()]);
    stop = startAddressRouting({ probe });
    await flush();
    calls[0].answer(null);
    await flush();
    jest.advanceTimersByTime(HOME_RECHECK_MS);
    expect(calls).toHaveLength(2);
    // That probe hangs (a home IP from another network times out): no second one.
    jest.advanceTimersByTime(HOME_RECHECK_MS * 2);
    expect(calls).toHaveLength(2);
    calls[1].answer(null);
    await flush();
    jest.advanceTimersByTime(HOME_RECHECK_MS);
    expect(calls).toHaveLength(3);
    calls[2].answer(null);
    await flush();
  });

  it('stops in the background and starts again in the foreground', async () => {
    const { calls, probe } = heldProbe();
    setConnections([mkConn()]);
    stop = startAddressRouting({ probe });
    await flush();
    calls[0].answer(null);
    await flush();
    appHandler!('background');
    jest.advanceTimersByTime(HOME_RECHECK_MS * 3);
    expect(calls).toHaveLength(1);
    appHandler!('active'); // the foreground re-pick
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].answer(null);
    await flush();
    jest.advanceTimersByTime(HOME_RECHECK_MS);
    expect(calls).toHaveLength(3);
  });

  it('asks nothing for a connection without a home address, and stops with the runner', async () => {
    const { calls, probe } = heldProbe();
    setConnections([mkConn({ addresses: { away: AWAY } })]);
    stop = startAddressRouting({ probe });
    await flush();
    jest.advanceTimersByTime(HOME_RECHECK_MS * 2);
    expect(calls).toHaveLength(0);
    setConnections([mkConn()]);
    await flush();
    calls[0].answer(null);
    await flush();
    stop();
    stop = null;
    jest.advanceTimersByTime(HOME_RECHECK_MS * 2);
    expect(calls).toHaveLength(1);
  });
});

describe('refreshing the addresses', () => {
  it('never asks a server without the addresses flag', async () => {
    servers = { [AWAY]: { id: 'srv-a', addresses: false } };
    setConnections([mkConn({ addresses: undefined })]);
    await refreshAddresses('srv-a');
    expect(requestsTo(AWAY).map((r) => r.path)).toEqual(['/api/v1/server']);
  });

  it('keeps a known home address that an answer from outside cannot know', async () => {
    servers = { [AWAY]: { id: 'srv-a', addresses: true, answer: { away: AWAY } } };
    setConnections([mkConn({ addresses: { home: HOME } })]);
    await refreshAddresses('srv-a');
    expect(useSession.getState().connections[0].addresses).toEqual({ home: HOME, away: AWAY });
  });

  it('reads them again when the connection comes back', async () => {
    servers = {};
    setConnections([mkConn({ addresses: undefined })]);
    stop = startAddressRouting();
    await flush();
    servers = { [AWAY]: { id: 'srv-a', addresses: true, answer: { away: AWAY } } };
    useReachability.setState({ online: { 'srv-a': false } });
    noteSuccess('srv-a');
    await flush();
    expect(useSession.getState().connections[0].addresses).toEqual({ away: AWAY });
  });
});

describe('the playing book', () => {
  const track = (base: string, i: number) => ({
    url: `${base}/api/v1/libraries/1/stream?path=Book/${i}.mp3&token=secret`,
  });
  const playing = (base: string): NowPlaying =>
    ({
      connectionId: 'srv-a',
      libraryId: 1,
      path: 'Book',
      title: 'Book',
      author: '',
      cover: '',
      queue: { tracks: [track(base, 0), track(base, 1)] },
    }) as unknown as NowPlaying;
  const load = (np: NowPlaying, state = 'playing', position = 754) =>
    usePlayer.setState({
      nowPlaying: np,
      snapshot: { state, position, trackIndex: 0 } as never,
      rate: 1.4,
      loadingBook: null,
    });

  beforeEach(() => setConnections([mkConn()]));
  afterEach(() => useAddressRoute.setState({ picks: {} }));

  it('restarts a streamed book playing from the previous address, in place', async () => {
    load(playing(AWAY));
    useAddressRoute.setState({ picks: { 'srv-a': HOME } });
    followPlayingBook();
    expect(startBookInPlace).toHaveBeenCalledWith(
      { connectionId: 'srv-a', libraryId: 1, path: 'Book' },
      { position: 754, speed: 1.4 },
    );
  });

  it('leaves a book on the address in use alone', () => {
    load(playing(HOME));
    useAddressRoute.setState({ picks: { 'srv-a': HOME } });
    followPlayingBook();
    expect(startBookInPlace).not.toHaveBeenCalled();
  });

  it('never starts a paused book, but restarts it at the next press on play', async () => {
    stop = startAddressRouting({ probe: async () => null });
    await flush();
    const np = playing(AWAY);
    load(np, 'paused');
    useAddressRoute.setState({ picks: { 'srv-a': HOME } });
    expect(startBookInPlace).not.toHaveBeenCalled();
    load(np, 'loading'); // the press: the engine is trying the old address
    expect(startBookInPlace).toHaveBeenCalledTimes(1);
  });

  it('leaves a downloaded book, a book still loading, or one with no place yet', () => {
    useAddressRoute.setState({ picks: { 'srv-a': HOME } });
    const local = {
      ...playing(AWAY),
      queue: { tracks: [{ url: 'file:///downloads/srv-a/1/book/0.mp3' }] },
    } as unknown as NowPlaying;
    load(local);
    followPlayingBook();
    load(playing(AWAY));
    usePlayer.setState({ loadingBook: 'srv-a:1:Book' });
    followPlayingBook();
    load(playing(AWAY), 'playing', 0);
    followPlayingBook();
    load(playing(AWAY), 'error');
    followPlayingBook();
    expect(startBookInPlace).not.toHaveBeenCalled();
  });

  it('does not retry a failed restart on every tick', async () => {
    jest.mocked(startBookInPlace).mockRejectedValueOnce(new Error('unreachable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const np = playing(AWAY);
    load(np);
    useAddressRoute.setState({ picks: { 'srv-a': HOME } });
    followPlayingBook();
    await flush();
    load(np, 'playing', 760);
    followPlayingBook();
    expect(startBookInPlace).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});
