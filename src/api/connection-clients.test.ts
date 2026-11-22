import { setAddressPick, useAddressRoute } from '@/api/address-route';
import { setConnectionAliases } from '@/lib/connection-id';
import { readKnownCapabilitiesFrom, resolveClient, sessionReady } from '@/api/connection-clients';
import { resetProxyRefusalsForTests, useProxyRefusals } from '@/api/proxy-refusal';
import type { Capabilities } from '@/api/types';
import { sessionHydrateFailed, useSession } from '@/stores/session';

// resolveClient reads the connection list and calls markNeedsReconnect straight off the
// zustand store, so mock the store to control both without wiring the real session (which
// a sibling change owns). markNeedsReconnect's signature is stable, so this stays valid.
jest.mock('@/stores/session', () => ({
  useSession: { getState: jest.fn() },
  sessionHydrateFailed: jest.fn(() => false),
}));
const mockNoteAnswer = jest.fn();
jest.mock('@/api/reachability', () => ({
  noteAnswer: (cid: string, at?: string) => mockNoteAnswer(cid, at),
}));

const getState = (useSession as unknown as { getState: jest.Mock }).getState;
const hydrateFailed = sessionHydrateFailed as jest.Mock;

type FetchResult = { status: number; body?: unknown };

/** Install a fake global fetch driven by `impl`; returns the jest mock. */
function installFetch(impl: (url: string) => FetchResult): jest.Mock {
  const mock = jest.fn((input: RequestInfo | URL) => {
    const { status, body } = impl(String(input));
    const text = body === undefined ? '' : JSON.stringify(body);
    const res = {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      text: () => Promise.resolve(text),
    } as Response;
    return Promise.resolve(res);
  });
  globalThis.fetch = mock as unknown as typeof globalThis.fetch;
  return mock;
}

const markNeedsReconnect = jest.fn();

function setStore(
  connections: {
    id: string;
    serverUrl: string;
    token: string | null;
    addresses?: { home?: string; away?: string };
  }[],
) {
  getState.mockReturnValue({
    connections,
    markNeedsReconnect,
    signInProxySets: {},
    status: 'ready',
  });
}

describe('connection-clients', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolveClient returns null for an unknown connection id', () => {
    setStore([]);
    expect(resolveClient('nope')).toBeNull();
  });

  it('resolveClient builds a client for a known connection', () => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'tok' }]);
    const client = resolveClient('c1');
    expect(client).not.toBeNull();
    expect(client!.baseUrl).toBe('https://h');
  });

  it.each([
    null,
    { capabilities: {} },
    { server_id: '', capabilities: {} },
    { server_id: 123, capabilities: {} },
    { server_id: '   ', capabilities: {} },
    { server_id: 'c1' },
  ])('rejects a malformed /server answer without flagging a reset (%j)', async (body) => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 't' }]);
    installFetch(() => ({ status: 200, body }));
    await expect(resolveClient('c1')!.serverInfo()).rejects.toMatchObject({
      name: 'UnexpectedServerAnswerError',
    });
    expect(markNeedsReconnect).not.toHaveBeenCalled();
  });

  it('a 401 through the resolved client flags THAT connection for reconnect', async () => {
    // This is the mutation-/progress-sync-path proof: the client resolveClient builds
    // carries the dead-token callback, so a revoked token surfacing as a 401 on any
    // request marks its connection (no per-call handling needed anywhere upstream).
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'dead' }]);
    installFetch(() => ({ status: 401, body: { error: 'invalid or expired token' } }));
    const client = resolveClient('c1')!;
    await expect(client.me()).rejects.toMatchObject({ name: 'ApiError', status: 401 });
    expect(markNeedsReconnect).toHaveBeenCalledWith('c1', 'auth');
  });

  it('a 401 through a client built before a re-pair does NOT flag the re-paired connection', async () => {
    // A request sent with the old token that comes back after the re-pair: the new token is
    // not dead, and the connection must not ask to be reconnected again.
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'old' }]);
    installFetch(() => ({ status: 401, body: { error: 'invalid or expired token' } }));
    const stale = resolveClient('c1')!;
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'new' }]);
    await expect(stale.me()).rejects.toMatchObject({ status: 401 });
    expect(markNeedsReconnect).not.toHaveBeenCalled();
    // The connection's own client, on its token now, still flags it.
    await expect(resolveClient('c1')!.me()).rejects.toMatchObject({ status: 401 });
    expect(markNeedsReconnect).toHaveBeenCalledWith('c1', 'auth');
  });

  it('resolves an old id the identity migration moved (an offline save, a car bookmark) to its connection', async () => {
    setConnectionAliases({ srv: 'srv.3' });
    try {
      setStore([{ id: 'srv.3', serverUrl: 'https://h', token: 'dead' }]);
      installFetch(() => ({ status: 401, body: { error: 'invalid or expired token' } }));
      const client = resolveClient('srv')!;
      expect(client.baseUrl).toBe('https://h');
      await expect(client.me()).rejects.toMatchObject({ status: 401 });
      // The flag lands on the connection itself, under its id now.
      expect(markNeedsReconnect).toHaveBeenCalledWith('srv.3', 'auth');
      setStore([]);
      expect(resolveClient('srv')).toBeNull();
    } finally {
      setConnectionAliases({});
    }
  });

  it('a 401 through a client built before the identity migration flags the connection under its new id', async () => {
    setStore([{ id: 'srv', serverUrl: 'https://h', token: 'dead' }]);
    installFetch(() => ({ status: 401, body: { error: 'invalid or expired token' } }));
    const client = resolveClient('srv')!;
    // The migration re-keys the connection (the same sign-in, the same token) meanwhile.
    setConnectionAliases({ srv: 'srv.3' });
    try {
      setStore([{ id: 'srv.3', serverUrl: 'https://h', token: 'dead' }]);
      await expect(client.me()).rejects.toMatchObject({ status: 401 });
      expect(markNeedsReconnect).toHaveBeenCalledWith('srv.3', 'auth');
    } finally {
      setConnectionAliases({});
    }
  });

  // The server's 401 for a wrong current password (`POST /auth/password`) names its code so a
  // client keeps its session: the token was taken, only the typed password was wrong.
  it('a wrong current password (401 `current_password_incorrect`) does NOT flag reconnect', async () => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'tok' }]);
    installFetch(() => ({
      status: 401,
      body: { error: 'current password is incorrect', code: 'current_password_incorrect' },
    }));
    await expect(resolveClient('c1')!.setPassword('newpass12', 'wrong')).rejects.toMatchObject({
      status: 401,
      code: 'current_password_incorrect',
      fromProxy: false,
    });
    expect(markNeedsReconnect).not.toHaveBeenCalled();
  });

  // FU-SLOWOK: the save loop, the car and the downloads ask through this client, so every
  // answer it gets counts for its connection's reachability, as a provider-built one's does.
  it('counts each answer the resolved client gets against its connection, a 5xx included', async () => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'tok' }]);
    installFetch(() => ({ status: 503, body: { error: 'busy' } }));
    await expect(resolveClient('c1')!.me()).rejects.toMatchObject({ status: 503 });
    // With the address that answered, so one the connection has left counts for nothing.
    expect(mockNoteAnswer).toHaveBeenCalledWith('c1', 'https://h');
    expect(mockNoteAnswer).toHaveBeenCalledTimes(1);
  });

  it('counts an answer to a client built before the identity migration under the new id', async () => {
    setStore([{ id: 'srv', serverUrl: 'https://h', token: 'tok' }]);
    installFetch(() => ({ status: 503, body: { error: 'busy' } }));
    const client = resolveClient('srv')!;
    setConnectionAliases({ srv: 'srv.3' });
    try {
      setStore([{ id: 'srv.3', serverUrl: 'https://h', token: 'tok' }]);
      await expect(client.me()).rejects.toMatchObject({ status: 503 });
      expect(mockNoteAnswer).toHaveBeenCalledWith('srv.3', 'https://h');
      expect(mockNoteAnswer).toHaveBeenCalledTimes(1);
    } finally {
      setConnectionAliases({});
    }
  });

  // WS-401-MARK: once the connection's last `/server` answer says the server marks its 401s
  // (`unauthorized_mark`), an unmarked 401 behind the proxy is never the server's.
  describe('a 401 behind a proxy, by what is known of the server', () => {
    const proxySets = {
      'https://h': { origin: 'https://h', headers: [{ name: 'X-Proxy', value: 'one' }] },
    };
    const known = new Map<string, Capabilities>();
    beforeEach(() => {
      known.clear();
      resetProxyRefusalsForTests();
      readKnownCapabilitiesFrom((cid) => known.get(cid));
      getState.mockReturnValue({
        connections: [{ id: 'c1', serverUrl: 'https://h', token: 'tok' }],
        markNeedsReconnect,
        proxySets,
        signInProxySets: {},
        status: 'ready',
      });
      installFetch(() => ({ status: 401, body: { error: 'invalid or expired token' } }));
    });
    afterEach(() => readKnownCapabilitiesFrom(() => undefined));

    it("does not sign out on the server's exact body once the server marks its 401s", async () => {
      known.set('c1', { unauthorized_mark: true } as Capabilities);
      await expect(resolveClient('c1')!.me()).rejects.toMatchObject({
        status: 401,
        fromProxy: true,
      });
      expect(markNeedsReconnect).not.toHaveBeenCalled();
      expect(useProxyRefusals.getState().refused).toEqual({ c1: 401 });
    });

    it.each([
      ['its /server is not known', undefined],
      ['an older server', {} as Capabilities],
    ])('signs out on it while %s', async (_, caps) => {
      if (caps) known.set('c1', caps);
      await expect(resolveClient('c1')!.me()).rejects.toMatchObject({
        status: 401,
        fromProxy: false,
      });
      expect(markNeedsReconnect).toHaveBeenCalledWith('c1', 'auth');
      expect(useProxyRefusals.getState().refused).toEqual({});
    });

    // With no proxy headers at all: still never the server's once it marks its 401s.
    it.each([
      ['marks its 401s', { unauthorized_mark: true } as Capabilities, false],
      ['is not known', undefined, true],
    ])(
      'with no proxy headers sent, a server that %s signs out on an unmarked 401: %s',
      async (_, caps, signsOut) => {
        getState.mockReturnValue({
          connections: [{ id: 'c1', serverUrl: 'https://h', token: 'tok' }],
          markNeedsReconnect,
          proxySets: {},
          signInProxySets: {},
          status: 'ready',
        });
        installFetch(() => ({ status: 401, body: { error: 'x' } }));
        if (caps) known.set('c1', caps);
        await expect(resolveClient('c1')!.me()).rejects.toMatchObject({
          status: 401,
          fromProxy: !signsOut,
        });
        if (signsOut) {
          expect(markNeedsReconnect).toHaveBeenCalledWith('c1', 'auth');
          expect(useProxyRefusals.getState().refused).toEqual({});
        } else {
          expect(markNeedsReconnect).not.toHaveBeenCalled();
          expect(useProxyRefusals.getState().refused).toEqual({ c1: 401 });
        }
      },
    );

    // A request sent before Sign in again that answers after it: the old token's refusal says
    // nothing of the new one, so the notice (and its Sign in again) does not come back.
    it('notes no refusal for a token the connection no longer holds', async () => {
      known.set('c1', { unauthorized_mark: true } as Capabilities);
      const stale = resolveClient('c1')!;
      getState.mockReturnValue({
        connections: [{ id: 'c1', serverUrl: 'https://h', token: 'new' }],
        markNeedsReconnect,
        proxySets,
        signInProxySets: {},
        status: 'ready',
      });
      await expect(stale.me()).rejects.toMatchObject({ status: 401, fromProxy: true });
      expect(useProxyRefusals.getState().refused).toEqual({});
      // Allowed: the token it holds now is still refused.
      await expect(resolveClient('c1')!.me()).rejects.toMatchObject({ status: 401 });
      expect(useProxyRefusals.getState().refused).toEqual({ c1: 401 });
      expect(markNeedsReconnect).not.toHaveBeenCalled();
    });

    // A revoked token behind a proxy that drops the mark: every route that checks the token
    // is refused, while the public `/server` answers 200. The episode lasts until a request
    // carrying the token the connection holds gets an answer past the check, so the notice
    // stays up and the queues are not told to send again at each `/server`.
    it('ends the episode only on an answer past the token check, for the token it holds', async () => {
      known.set('c1', { unauthorized_mark: true } as Capabilities);
      const stale = resolveClient('c1')!;
      await expect(stale.me()).rejects.toMatchObject({ status: 401, fromProxy: true });
      expect(useProxyRefusals.getState().refused).toEqual({ c1: 401 });
      // Denied: the public `/server` says nothing of the token.
      installFetch(() => ({
        status: 200,
        body: { server_id: 'c1', server_name: 'H', capabilities: {} },
      }));
      await stale.serverInfo();
      expect(useProxyRefusals.getState().refused).toEqual({ c1: 401 });
      // Denied: an answer to the token the connection held before Sign in again.
      getState.mockReturnValue({
        connections: [{ id: 'c1', serverUrl: 'https://h', token: 'new' }],
        markNeedsReconnect,
        proxySets,
        signInProxySets: {},
        status: 'ready',
      });
      installFetch(() => ({ status: 200, body: { id: 1, username: 'chris' } }));
      await stale.me();
      expect(useProxyRefusals.getState().refused).toEqual({ c1: 401 });
      // Allowed: the token it holds now, taken.
      await resolveClient('c1')!.me();
      expect(useProxyRefusals.getState().refused).toEqual({});
    });

    it("reads the flag under the connection's id now (a client built before the identity migration)", async () => {
      getState.mockReturnValue({
        connections: [{ id: 'old', serverUrl: 'https://h', token: 'tok' }],
        markNeedsReconnect,
        proxySets,
        signInProxySets: {},
        status: 'ready',
      });
      const stale = resolveClient('old')!;
      getState.mockReturnValue({
        connections: [{ id: 'srv.7', serverUrl: 'https://h', token: 'tok' }],
        markNeedsReconnect,
        proxySets,
        signInProxySets: {},
        status: 'ready',
      });
      setConnectionAliases({ old: 'srv.7' });
      try {
        known.set('srv.7', { unauthorized_mark: true } as Capabilities);
        await expect(stale.me()).rejects.toMatchObject({ status: 401, fromProxy: true });
        expect(markNeedsReconnect).not.toHaveBeenCalled();
      } finally {
        setConnectionAliases({});
      }
    });
  });

  it('a 403 through the resolved client does NOT flag reconnect (valid token, forbidden)', async () => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'tok' }]);
    installFetch(() => ({ status: 403, body: { error: 'no access to this path' } }));
    const client = resolveClient('c1')!;
    await expect(client.me()).rejects.toMatchObject({ status: 403 });
    expect(markNeedsReconnect).not.toHaveBeenCalled();
  });

  describe('home and away addresses', () => {
    const HOME = 'http://192.168.1.20:8080';
    const conn = {
      id: 'c1',
      serverUrl: 'https://away.example',
      token: 'tok',
      addresses: { home: HOME, away: 'https://away.example' },
    };
    afterEach(() => useAddressRoute.setState({ picks: {} }));

    it('builds the client on the address in use now', () => {
      setStore([conn]);
      expect(resolveClient('c1')!.baseUrl).toBe('https://away.example');
      setAddressPick('c1', HOME);
      expect(resolveClient('c1')!.baseUrl).toBe(HOME);
      expect(resolveClient('c1')!.coverUrl(1, 'A')).toMatch(/^http:\/\/192\.168\.1\.20:8080\//);
    });

    it('ignores a pick that is no longer one of the connection addresses', () => {
      setStore([{ ...conn, addresses: undefined }]);
      setAddressPick('c1', HOME);
      expect(resolveClient('c1')!.baseUrl).toBe('https://away.example');
    });
  });

  it('sessionReady reflects the store status', () => {
    getState.mockReturnValue({
      connections: [],
      markNeedsReconnect,
      signInProxySets: {},
      status: 'loading',
    });
    expect(sessionReady()).toBe(false);
    getState.mockReturnValue({
      connections: [],
      markNeedsReconnect,
      signInProxySets: {},
      status: 'ready',
    });
    expect(sessionReady()).toBe(true);
  });

  it('is not ready after a hydrate that failed (the list never loaded), until one succeeds', () => {
    getState.mockReturnValue({
      connections: [],
      markNeedsReconnect,
      signInProxySets: {},
      status: 'unauthenticated',
    });
    hydrateFailed.mockReturnValueOnce(true);
    expect(sessionReady()).toBe(false);
    expect(sessionReady()).toBe(true);
  });
});
