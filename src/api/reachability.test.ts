const mockResolveClient = jest.fn();
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockResolveClient(cid),
}));
const mockNetworkListeners: ((s: { isConnected?: boolean }) => void)[] = [];
jest.mock('expo-network', () => ({
  addNetworkStateListener: (cb: (s: { isConnected?: boolean }) => void) => {
    mockNetworkListeners.push(cb);
    return { remove: () => mockNetworkListeners.splice(mockNetworkListeners.indexOf(cb), 1) };
  },
}));

/* eslint-disable import/first */
import type { NetworkStateType } from 'expo-network';

import { ApiError, NetworkError, TimeoutError } from '@/api/client';
import {
  anyOffline,
  checkReachability,
  deviceNetworkChanged,
  isReachable,
  noteFailure,
  noteSuccess,
  onReconnect,
  REJOIN_RETRY_MS,
  serverStatus,
  useReachability,
} from '@/api/reachability';
import { useSession } from '@/stores/session';
/* eslint-enable import/first */

/** A client whose `/server` never answers. */
const deadClient = () => ({
  serverInfo: jest.fn(async () => {
    throw new TypeError('Network request failed');
  }),
});

/** Mark `cid` down the only way it goes down: a check of its server that got no answer. */
async function markDown(
  cid: string,
  check: (cid: string) => Promise<void> = checkReachability,
): Promise<void> {
  mockResolveClient.mockReturnValue(deadClient());
  await check(cid);
}

describe('serverStatus', () => {
  it('prefers the reconnect flag, then reachability', () => {
    expect(serverStatus({ id: 'a', needsReconnect: 'server-reset' }, { a: false })).toBe(
      'reconnect',
    );
    expect(serverStatus({ id: 'a' }, { a: false })).toBe('offline');
    expect(serverStatus({ id: 'a' }, {})).toBe('online');
  });
});

// Exercises the per-connection reachability state machine. A connection goes down only
// through a check that got no answer (`markDown`), and up through `noteSuccess`.
// Fake timers keep the offline probe's setInterval from leaking between tests.
describe('per-connection reachability state machine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockResolveClient.mockReset();
    useReachability.setState({ online: {} });
  });

  afterEach(() => {
    // Clear any state so the probe interval (started when a connection went offline)
    // stops, then drop timers.
    useReachability.setState({ online: {} });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('treats an unknown connection as reachable (optimistic default)', () => {
    expect(isReachable('c1')).toBe(true);
  });

  // FU-NOTEERR: one request with no answer never marks its server down by itself.
  it('has the server checked for a request with no answer, and only the check marks it down', async () => {
    const dead = deadClient();
    mockResolveClient.mockReturnValue(dead);
    noteFailure('c1', new TimeoutError(5000));
    expect(isReachable('c1')).toBe(true);
    expect(dead.serverInfo).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(isReachable('c1')).toBe(false);
  });

  it('leaves the server up when the check is answered', async () => {
    const serverInfo = jest.fn(async () => ({}));
    mockResolveClient.mockReturnValue({ serverInfo });
    noteFailure('c1', new TypeError('Network request failed'));
    await jest.advanceTimersByTimeAsync(0);
    expect(serverInfo).toHaveBeenCalled();
    expect(isReachable('c1')).toBe(true);
  });

  it('asks nothing for an answer (an ApiError) or a cancellation', () => {
    const dead = deadClient();
    mockResolveClient.mockReturnValue(dead);
    noteFailure('c1', new ApiError(503, 'unavailable'));
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    noteFailure('c1', abort);
    expect(dead.serverInfo).not.toHaveBeenCalled();
    expect(isReachable('c1')).toBe(true);
  });

  it('marks only the failing connection offline, not its siblings', async () => {
    await markDown('c1');
    expect(isReachable('c1')).toBe(false);
    expect(isReachable('c2')).toBe(true); // unaffected
  });

  it('anyOffline reflects whether any connection is down', async () => {
    expect(anyOffline(useReachability.getState().online)).toBe(false);
    await markDown('c1');
    expect(anyOffline(useReachability.getState().online)).toBe(true);
    noteSuccess('c1');
    expect(anyOffline(useReachability.getState().online)).toBe(false);
  });

  it('fires onReconnect with the recovered connection id, exactly once per edge', async () => {
    const handler = jest.fn();
    const unsubscribe = onReconnect(handler);

    await markDown('c1'); // online -> offline
    expect(isReachable('c1')).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    noteSuccess('c1'); // offline -> online edge
    expect(isReachable('c1')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('c1');

    // A redundant online->online call must not re-fire the handler.
    noteSuccess('c1');
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('reconnect edges are independent per connection', async () => {
    const handler = jest.fn();
    const unsubscribe = onReconnect(handler);

    await markDown('c1');
    await markDown('c2');
    noteSuccess('c2'); // only c2 recovers
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('c2');
    expect(isReachable('c1')).toBe(false);

    unsubscribe();
  });
});

describe('the offline probe', () => {
  /** A fresh copy of the module: no probe running and no clients registered. */
  function fresh(): typeof import('@/api/reachability') {
    let mod!: typeof import('@/api/reachability');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('@/api/reachability');
    });
    return mod;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockResolveClient.mockReset();
    mockResolveClient.mockReturnValue(null);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reaches the server through a client built from the session when no provider registered one (the car with no React tree)', async () => {
    const r = fresh();
    await markDown('c1', r.checkReachability);
    const serverInfo = jest.fn(async () => ({}));
    mockResolveClient.mockReturnValue({ serverInfo });
    const handler = jest.fn();
    const off = r.onReconnect(handler);
    expect(r.isReachable('c1')).toBe(false);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockResolveClient).toHaveBeenCalledWith('c1');
    expect(serverInfo).toHaveBeenCalled();
    expect(r.isReachable('c1')).toBe(true);
    expect(handler).toHaveBeenCalledWith('c1');
    off();
  });

  /** A client whose `/server` waits until the test settles it. */
  function pendingClient(baseUrl: string) {
    let fail!: (e: unknown) => void;
    const serverInfo = jest.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    return {
      client: { serverInfo, baseUrl } as never,
      serverInfo,
      fail: (e: unknown) => fail(e),
    };
  }

  // frontend#131: a check is stale once something newer is known, and records nothing.
  it('leaves a server up that another request reached while a check got no answer', async () => {
    const r = fresh();
    const { client, fail } = pendingClient('https://h');
    r.setReachabilityClients(new Map([['c1', client]]));
    const check = r.checkReachability('c1');
    r.noteSuccess('c1'); // a save got through while the check waited out its timeout
    fail(new TypeError('Network request failed')); // a fresh module: its own TimeoutError class
    await check;
    expect(r.isReachable('c1')).toBe(true);
  });

  // FU-SLOWOK: a slow but healthy server answers queries while its check times out.
  it('leaves a server up whose client got an answer while a check got none', async () => {
    const r = fresh();
    const { client, fail } = pendingClient('https://h');
    r.setReachabilityClients(new Map([['c1', client]]));
    const check = r.checkReachability('c1');
    r.noteAnswer('c1'); // a query got its answer while the check waited out its timeout
    fail(new TypeError('Network request failed'));
    await check;
    expect(r.isReachable('c1')).toBe(true);
  });

  it('counts an answer without marking a down server up', async () => {
    const r = fresh();
    await markDown('c1', r.checkReachability);
    r.noteAnswer('c1');
    expect(r.isReachable('c1')).toBe(false);
  });

  it('marks a server down when its check got no answer and nothing else did', async () => {
    const r = fresh();
    const { client, fail } = pendingClient('https://h');
    r.setReachabilityClients(new Map([['c1', client]]));
    const check = r.checkReachability('c1');
    fail(new TypeError('Network request failed'));
    await check;
    expect(r.isReachable('c1')).toBe(false);
  });

  it('records nothing when its connection moved to another address while it ran', async () => {
    const r = fresh();
    const home = pendingClient('http://192.168.1.5:8080');
    r.setReachabilityClients(new Map([['c1', home.client]]));
    const check = r.checkReachability('c1');
    // The address runner left home: the connection's client is the away one now.
    r.setReachabilityClients(new Map([['c1', pendingClient('https://h').client]]));
    home.fail(new TypeError('Network request failed'));
    await check;
    expect(r.useReachability.getState().online.c1).toBeUndefined();
  });

  it('records nothing when its connection was removed while it ran', async () => {
    const r = fresh();
    const { client, fail } = pendingClient('https://h');
    r.setReachabilityClients(new Map([['c1', client]]));
    const check = r.checkReachability('c1');
    r.setReachabilityClients(new Map()); // gone (and the session no longer has it)
    fail(new TypeError('Network request failed'));
    await check;
    expect(r.useReachability.getState().online.c1).toBeUndefined();
  });

  it('checks again after a stale check when a query succeeded while it waited', async () => {
    const r = fresh();
    const { client, serverInfo, fail } = pendingClient('https://h');
    await markDown('c1', r.checkReachability);
    r.setReachabilityClients(new Map([['c1', client]]));
    const check = r.checkReachability('c1');
    r.recheckReachability('c1'); // a Retry got through while the check waited
    expect(serverInfo).toHaveBeenCalledTimes(1);
    fail(new TypeError('Network request failed'));
    await check;
    expect(serverInfo).toHaveBeenCalledTimes(2);
    fail(new TypeError('Network request failed'));
  });

  it("probes through the provider's client when it registered one", async () => {
    const r = fresh();
    await markDown('c1', r.checkReachability);
    mockResolveClient.mockClear();
    const serverInfo = jest.fn(async () => ({}));
    r.setReachabilityClients(new Map([['c1', { serverInfo } as never]]));
    await jest.advanceTimersByTimeAsync(20_000);
    expect(serverInfo).toHaveBeenCalled();
    expect(mockResolveClient).not.toHaveBeenCalled();
    expect(r.isReachable('c1')).toBe(true);
  });
});

// W2 F1/F2: the app's own network state, and the client's NetworkError.
describe('the device network (native)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockResolveClient.mockReset();
    useReachability.setState({ online: {} });
    useSession.setState({ connections: [{ id: 'c1' }, { id: 'c2' }] as never });
    deviceNetworkChanged({}); // a state of its own: each test's first event is a change
  });

  afterEach(() => {
    useReachability.setState({ online: {} });
    useSession.setState({ connections: [] });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('counts a NetworkError as no answer: a check, then down', async () => {
    mockResolveClient.mockReturnValue(deadClient());
    noteFailure('c1', new NetworkError(new Error('fetch failed: offline')));
    await jest.advanceTimersByTimeAsync(0);
    expect(isReachable('c1')).toBe(false);
  });

  it('follows the system network from the start (a listener at import)', () => {
    expect(mockNetworkListeners.length).toBeGreaterThan(0);
  });

  it('checks every connection still up when the network goes, marking them down', async () => {
    mockResolveClient.mockImplementation(() => ({
      baseUrl: 'https://h',
      serverInfo: async () => {
        throw new NetworkError(new Error('offline'));
      },
    }));
    deviceNetworkChanged({ isConnected: false });
    await jest.advanceTimersByTimeAsync(0);
    expect(isReachable('c1')).toBe(false);
    expect(isReachable('c2')).toBe(false);
  });

  it('leaves a server up whose check answers though the system says offline', async () => {
    mockResolveClient.mockReturnValue({ baseUrl: 'https://h', serverInfo: async () => ({}) });
    deviceNetworkChanged({ isConnected: false });
    await jest.advanceTimersByTimeAsync(0);
    expect(isReachable('c1')).toBe(true);
  });

  it('probes the servers marked down as soon as the network is back, and once more soon after', async () => {
    await markDown('c1');
    const handler = jest.fn();
    const off = onReconnect(handler);
    const serverInfo = jest.fn(async () => {
      if (serverInfo.mock.calls.length < 2) throw new NetworkError(new Error('not routed yet'));
      return {};
    });
    mockResolveClient.mockReturnValue({ baseUrl: 'https://h', serverInfo });
    deviceNetworkChanged({ isConnected: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(serverInfo).toHaveBeenCalledTimes(1);
    expect(isReachable('c1')).toBe(false);
    // Well before the 20 s probe.
    await jest.advanceTimersByTimeAsync(REJOIN_RETRY_MS);
    expect(serverInfo).toHaveBeenCalledTimes(2);
    expect(isReachable('c1')).toBe(true);
    expect(handler).toHaveBeenCalledWith('c1');
    off();
  });

  it("a repeat of the same state asks nothing (Android's capability bursts)", async () => {
    await markDown('c1');
    const serverInfo = jest.fn(async () => {
      throw new NetworkError(new Error('still away'));
    });
    mockResolveClient.mockReturnValue({ baseUrl: 'https://h', serverInfo });
    const wifi = { isConnected: true, type: 'WIFI' as NetworkStateType };
    deviceNetworkChanged(wifi);
    await jest.advanceTimersByTimeAsync(REJOIN_RETRY_MS);
    expect(serverInfo).toHaveBeenCalledTimes(2);
    deviceNetworkChanged(wifi);
    deviceNetworkChanged({ ...wifi });
    await jest.advanceTimersByTimeAsync(REJOIN_RETRY_MS);
    expect(serverInfo).toHaveBeenCalledTimes(2);
    // Another network is a change.
    deviceNetworkChanged({ isConnected: true, type: 'CELLULAR' as NetworkStateType });
    await jest.advanceTimersByTimeAsync(0);
    expect(serverInfo).toHaveBeenCalledTimes(3);
  });

  it('a check still out when the network comes back is asked again as it ends', async () => {
    await markDown('c1');
    let fail: (e: Error) => void = () => {};
    const serverInfo = jest
      .fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
      .mockImplementation(async () => ({}));
    mockResolveClient.mockReturnValue({ baseUrl: 'https://h', serverInfo });
    void checkReachability('c1'); // sent on the old network: waits out its timeout
    deviceNetworkChanged({ isConnected: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(serverInfo).toHaveBeenCalledTimes(1);
    fail(new NetworkError(new Error('timed out on the old network')));
    await jest.advanceTimersByTimeAsync(0);
    expect(serverInfo).toHaveBeenCalledTimes(2);
    expect(isReachable('c1')).toBe(true);
  });

  it('asks nothing on a network change while every server is up', async () => {
    const serverInfo = jest.fn(async () => ({}));
    mockResolveClient.mockReturnValue({ baseUrl: 'https://h', serverInfo });
    deviceNetworkChanged({ isConnected: true });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(serverInfo).not.toHaveBeenCalled();
  });

  it('asks the new address when its connection moved while a check got no answer', async () => {
    const home = {
      baseUrl: 'http://192.168.1.5:8080',
      serverInfo: jest.fn(async () => {
        throw new NetworkError(new Error('gone'));
      }),
    };
    const away = { baseUrl: 'https://h', serverInfo: jest.fn(async () => ({})) };
    mockResolveClient.mockReturnValueOnce(home).mockReturnValue(away);
    await checkReachability('c1');
    await jest.advanceTimersByTimeAsync(0);
    expect(away.serverInfo).toHaveBeenCalledTimes(1);
    expect(isReachable('c1')).toBe(true);
  });
});
