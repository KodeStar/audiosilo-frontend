import { liveClient } from '@/api/live-client';
import { useSession } from '@/stores/session';

// The real `resolveClient` over a stand-in session store, so a test can change a
// connection's token between taking the client and sending through it (a re-pair).
jest.mock('@/stores/session', () => ({
  useSession: { getState: jest.fn() },
  sessionHydrateFailed: jest.fn(() => false),
}));
jest.mock('@/api/reachability', () => ({ noteAnswer: jest.fn() }));

const getState = (useSession as unknown as { getState: jest.Mock }).getState;
const markNeedsReconnect = jest.fn();

function setStore(connections: { id: string; serverUrl: string; token: string | null }[]) {
  getState.mockReturnValue({ connections, markNeedsReconnect, status: 'ready' });
}

/** A fake fetch answering 200 to everything; returns the Authorization header of each call. */
function installFetch(): string[] {
  const auth: string[] = [];
  globalThis.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get('Authorization') ?? '');
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('{}'),
    } as Response);
  }) as unknown as typeof globalThis.fetch;
  return auth;
}

const body = {
  position: 40,
  duration: 100,
  finished: false,
  playback_speed: 1,
  version: 0,
  device_id: 'dev-1',
  updated_at: '2026-11-19T10:00:00Z',
};

describe('liveClient', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is null for a connection that is not signed in', () => {
    setStore([]);
    expect(liveClient('c1')).toBeNull();
  });

  it('sends with the token the connection holds when the request goes, not when it was taken', async () => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'old' }]);
    const auth = installFetch();
    const api = liveClient('c1')!;
    // A re-pair while the save waited its turn (this device's record, a guard's check).
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'new' }]);
    await api.saveProgress(2, 'A/Book.m4b', body);
    expect(auth).toEqual(['Bearer new']);
  });

  it('keeps the last client of a connection removed before the send', async () => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'old' }]);
    const auth = installFetch();
    const api = liveClient('c1')!;
    setStore([]);
    await api.saveProgress(2, 'A/Book.m4b', body);
    expect(auth).toEqual(['Bearer old']);
  });

  it('reads plain fields off the client in use now (the address too)', () => {
    setStore([{ id: 'c1', serverUrl: 'https://h', token: 'old' }]);
    const api = liveClient('c1')!;
    setStore([{ id: 'c1', serverUrl: 'https://moved', token: 'old' }]);
    expect(api.baseUrl).toBe('https://moved');
  });
});
