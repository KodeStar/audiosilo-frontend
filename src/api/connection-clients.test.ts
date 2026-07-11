import { resolveClient, sessionReady } from '@/api/connection-clients';
import { useSession } from '@/stores/session';

// resolveClient reads the connection list and calls markNeedsReconnect straight off the
// zustand store, so mock the store to control both without wiring the real session (which
// a sibling change owns). markNeedsReconnect's signature is stable, so this stays valid.
jest.mock('@/stores/session', () => ({
  useSession: { getState: jest.fn() },
}));

const getState = (useSession as unknown as { getState: jest.Mock }).getState;

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

function setStore(connections: { id: string; serverUrl: string; token: string | null }[]) {
  getState.mockReturnValue({ connections, markNeedsReconnect, status: 'ready' });
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

  it('a 403 through the resolved client does NOT flag reconnect (valid token, forbidden)', async () => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'tok' }]);
    installFetch(() => ({ status: 403, body: { error: 'no access to this path' } }));
    const client = resolveClient('c1')!;
    await expect(client.me()).rejects.toMatchObject({ status: 403 });
    expect(markNeedsReconnect).not.toHaveBeenCalled();
  });

  it('sessionReady reflects the store status', () => {
    getState.mockReturnValue({ connections: [], markNeedsReconnect, status: 'loading' });
    expect(sessionReady()).toBe(false);
    getState.mockReturnValue({ connections: [], markNeedsReconnect, status: 'ready' });
    expect(sessionReady()).toBe(true);
  });
});
