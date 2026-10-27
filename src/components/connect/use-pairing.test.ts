import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockExchange = jest.fn();
// The base URL of each exchange, in order.
const mockExchangedAt: string[] = [];
// `GET /me` with a stored token: (base, token) of each.
const mockMe = jest.fn();
jest.mock('@/api/client', () => {
  const actual = jest.requireActual('@/api/client');
  return {
    ...actual,
    ApiClient: class {
      base: string;
      token: string | null;
      constructor(base: string, token: string | null = null) {
        this.base = base;
        this.token = token;
      }
      exchange = (...a: unknown[]) => {
        mockExchangedAt.push(this.base);
        return mockExchange(...a);
      };
      serverInfo = async () => ({ name: 'Hearthside' });
      me = () => mockMe(this.base, this.token);
    },
  };
});
const mockFinish = jest.fn();
const mockEnd = jest.fn();
jest.mock('./finish-connect', () => ({
  finishConnect: (...a: unknown[]) => mockFinish(...a),
  endConnect: (...a: unknown[]) => mockEnd(...a),
}));
// Whether the session read failed at launch (its connections never loaded).
let mockHydrateFailed = false;
jest.mock('@/stores/session', () => ({
  ...jest.requireActual('@/stores/session'),
  sessionHydrateFailed: () => mockHydrateFailed,
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Kitchen iPad' }));
// The tokenless `GET /server` probe of the home address: the server_id it answers.
const mockProbe = jest.fn();
jest.mock('@/api/server-id-probe', () => ({
  probeServerId: (url: string) => mockProbe(url),
}));

/* eslint-disable import/first */
import { ApiError, TimeoutError } from '@/api/client';
import type { User } from '@/api/types';
import { setConnectForNewProfile } from '@/components/profiles/connect-intent';
import type { PairingScan } from '@/lib/pairing';
import { type Connection, useSession } from '@/stores/session';

import { type PairOutcome, pairFailureKind, useLinkPairing } from './use-pairing';
/* eslint-enable import/first */

const scan = { base: 'https://books.example', token: 'tok' };

/** The error a refused exchange `e` of `link` leaves, in words. */
async function errorFor(e: unknown, link: typeof scan = scan): Promise<string | null> {
  mockExchange.mockRejectedValue(e);
  const { result } = await renderHook(() => useLinkPairing());
  let paired: PairOutcome | undefined;
  await act(async () => {
    paired = await result.current.pair(link);
  });
  expect(paired).not.toBe('paired');
  expect(result.current.pairing).toBe(false);
  return result.current.error;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExchangedAt.length = 0;
  mockHydrateFailed = false;
  useSession.setState({ connections: [] });
});

describe('useLinkPairing', () => {
  it('pairs and finishes the connect flow with the server name', async () => {
    const session = { token: 's', user: { id: 1, username: 'evie' }, server_id: 'a' };
    mockExchange.mockResolvedValue(session);
    const { result } = await renderHook(() => useLinkPairing());
    await act(async () => {
      expect(await result.current.pair(scan)).toBe('paired');
    });
    expect(mockExchange).toHaveBeenCalledWith('tok', 'Kitchen iPad');
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: scan.base, session, name: 'Hearthside' }),
    );
  });

  it("says a refused link in the app's words, never the server's English", async () => {
    const said = await errorFor(new ApiError(401, 'invite has expired - ask for a new invite'));
    expect(said).toBe(
      'This pairing link has expired or was already used. Ask for a new one, or enter your invite code on the sign-in screen.',
    );
    expect(said).not.toMatch(/invite has expired/);
  });

  it('says the server failing itself apart from a refused link', async () => {
    expect(await errorFor(new ApiError(500, 'could not issue session'))).toBe(
      "The server couldn't finish pairing. Try again, or enter your invite code on the sign-in screen.",
    );
  });

  it('says too many tries, and no answer at all, in words of its own', async () => {
    expect(await errorFor(new ApiError(429, 'slow down'))).toBe(
      'Too many tries. Wait a few minutes and try again.',
    );
    expect(await errorFor(new TypeError('Network request failed'))).toBe(
      "Couldn't reach the server. If it uses its own (self-signed) certificate, update the server, or connect on your home network.",
    );
  });

  it('reports a dead link apart from one that may work later (CONNECT-14)', async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(pairFailureKind(new ApiError(status, 'no'), false)).toBe('refused');
    }
    expect(pairFailureKind(new ApiError(401, 'no', 'invite_used'), false)).toBe('refused');
    for (const e of [
      new ApiError(429, 'slow down'),
      new ApiError(503, 'busy'),
      new ApiError(500, 'oops'),
      new TypeError('Network request failed'),
      new TimeoutError(15000),
    ]) {
      expect(pairFailureKind(e, false)).toBe('temporary');
    }
    // `pair` resolves what `pairFailureKind` says.
    mockExchange.mockRejectedValue(new ApiError(503, 'busy'));
    const { result } = await renderHook(() => useLinkPairing());
    let got: PairOutcome | undefined;
    await act(async () => {
      got = await result.current.pair(scan);
    });
    expect(got).toBe('temporary');
  });

  it('counts a failure after the exchange as a dead link (the token is spent)', () => {
    expect(pairFailureKind(new Error('disk full'), true)).toBe('refused');
    expect(pairFailureKind(new ApiError(409, 'no', 'invite_expired'), false)).toBe('refused');
    expect(pairFailureKind(new ApiError(409, 'no'), false)).toBe('temporary');
  });

  it('names a self-signed certificate only for an https link on native that did not time out', async () => {
    const plain = 'Could not reach the server to finish pairing.';
    const down = new TypeError('Network request failed');
    expect(await errorFor(new TimeoutError(15000))).toBe(plain);
    expect(await errorFor(down, { base: 'http://192.168.1.20:8080', token: 'tok' })).toBe(plain);
    const os = Platform.OS;
    Platform.OS = 'web';
    try {
      expect(await errorFor(down)).toBe(plain);
    } finally {
      Platform.OS = os;
    }
  });
});

describe('useLinkPairing: the home http fallback', () => {
  const SID = 'srv-home';
  const session = { token: 's', user: { id: 1, username: 'evie' }, server_id: SID };
  const BASE = 'https://192.168.1.205:8080';
  const HOME = 'http://192.168.1.205:8080';
  const homeScan: { base: string; token: string; addresses: { home: string }; serverId?: string } =
    { base: BASE, token: 'tok', addresses: { home: HOME }, serverId: SID };
  const down = () => new TypeError('Network request failed');

  beforeEach(() => mockProbe.mockResolvedValue(SID));

  async function pairWith(s: typeof homeScan) {
    const { result } = await renderHook(() => useLinkPairing());
    let paired: PairOutcome | undefined;
    await act(async () => {
      paired = await result.current.pair(s);
    });
    return { paired, error: result.current.error };
  }

  it("exchanges at the link's plain-http home when its https base can't connect and home is the link's server", async () => {
    mockExchange.mockRejectedValueOnce(down()).mockResolvedValueOnce(session);
    expect((await pairWith(homeScan)).paired).toBe('paired');
    expect(mockProbe).toHaveBeenCalledWith(HOME);
    expect(mockExchangedAt).toEqual([BASE, HOME]);
    // Stored with the https base (it fails safely by TLS elsewhere), home as the first pick.
    expect(mockFinish).toHaveBeenCalledWith({
      serverUrl: BASE,
      session,
      linkAddresses: { home: HOME },
      name: 'Hearthside',
      answeredAt: HOME,
    });
  });

  it('pairs at the base with no pick when the base answers', async () => {
    mockExchange.mockResolvedValueOnce(session);
    expect((await pairWith(homeScan)).paired).toBe('paired');
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith(
      expect.not.objectContaining({ answeredAt: expect.anything() }),
    );
    expect(mockFinish.mock.calls[0][0].serverUrl).toBe(BASE);
  });

  it('never sends the token to a home that answers as another server, or not at all', async () => {
    for (const answer of ['srv-other', null]) {
      mockExchangedAt.length = 0;
      mockProbe.mockResolvedValue(answer);
      mockExchange.mockRejectedValue(down());
      const { paired, error } = await pairWith(homeScan);
      expect(paired).toBe('temporary');
      expect(mockExchangedAt).toEqual([BASE]);
      expect(error).toMatch(/^Couldn't reach the server/);
    }
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("never falls back for a link without the server's id (an older server)", async () => {
    mockExchange.mockRejectedValue(down());
    const { serverId: _drop, ...noSid } = homeScan;
    expect((await pairWith(noSid)).paired).toBe('temporary');
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockExchangedAt).toEqual([BASE]);
  });

  it("keeps no session another server issued at home, and says the base couldn't be reached", async () => {
    mockExchange
      .mockRejectedValueOnce(down())
      .mockResolvedValueOnce({ ...session, server_id: 'srv-other' });
    const { paired, error } = await pairWith(homeScan);
    expect(paired).toBe('temporary');
    expect(mockExchangedAt).toEqual([BASE, HOME]);
    expect(error).toMatch(/^Couldn't reach the server/);
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it('does not fall back when the base answered, and reports what it said', async () => {
    mockExchange.mockRejectedValueOnce(new ApiError(401, 'expired'));
    const { paired, error } = await pairWith(homeScan);
    expect(paired).toBe('refused');
    expect(mockExchangedAt).toEqual([BASE]);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(error).toMatch(/expired or was already used/);
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("says the base couldn't be reached when the home can't either", async () => {
    mockExchange.mockRejectedValue(down());
    const { paired, error } = await pairWith(homeScan);
    expect(paired).toBe('temporary');
    expect(mockExchangedAt).toEqual([BASE, HOME]);
    expect(error).toMatch(/^Couldn't reach the server/);
  });

  it('names no certificate for a failure after the exchange (storing the connection)', async () => {
    mockExchange.mockResolvedValueOnce(session);
    mockFinish.mockRejectedValueOnce(new Error('could not store'));
    const { paired, error } = await pairWith(homeScan);
    expect(paired).toBe('refused');
    expect(error).toBe('Could not reach the server to finish pairing.');
  });

  it("says what the home's server answered when it answered", async () => {
    mockExchange.mockRejectedValueOnce(down()).mockRejectedValueOnce(new ApiError(500, 'boom'));
    expect((await pairWith(homeScan)).error).toMatch(/^The server couldn't finish pairing/);
    expect(mockFinish).not.toHaveBeenCalled();
  });
});

describe('useLinkPairing: a link that names a book', () => {
  const book = { libraryId: 2, path: 'Author/Book' };
  const bookScan = { ...scan, serverId: 'srv-1', userId: 1, book };
  const chris: Connection = {
    id: 'srv-1.1',
    serverId: 'srv-1',
    serverUrl: scan.base,
    name: 'Hearthside',
    token: 't',
    user: { id: 1, username: 'chris' } as User,
  };
  const session = { token: 's', user: { id: 1, username: 'chris' }, server_id: 'srv-1' };
  // A test swaps the store's hydrate: the next one gets the real one back.
  const realHydrate = useSession.getState().hydrate;
  afterEach(() => {
    useSession.setState({ hydrate: realHydrate });
    setConnectForNewProfile(false);
  });

  async function pairWith(s: PairingScan) {
    const { result } = await renderHook(() => useLinkPairing());
    let paired: PairOutcome | undefined;
    await act(async () => {
      paired = await result.current.pair(s);
    });
    return paired;
  }

  it('opens the book without the exchange when already signed in as its user there', async () => {
    useSession.setState({ connections: [chris] });
    expect(await pairWith(bookScan)).toBe('paired');
    expect(mockEnd).toHaveBeenCalledWith('srv-1.1', book);
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("asks with the stored token at the connection's own address, never the link's", async () => {
    useSession.setState({ connections: [chris] });
    expect(await pairWith({ ...bookScan, base: 'https://elsewhere.example' })).toBe('paired');
    expect(mockMe).toHaveBeenCalledWith(scan.base, 't');
    expect(mockMe).not.toHaveBeenCalledWith('https://elsewhere.example', expect.anything());
  });

  it('exchanges when the server refuses the stored token (a fresh tab never knows)', async () => {
    useSession.setState({ connections: [chris] });
    mockMe.mockRejectedValueOnce(new ApiError(401, 'invalid or expired token'));
    mockExchange.mockResolvedValue(session);
    expect(await pairWith(bookScan)).toBe('paired');
    expect(mockExchange).toHaveBeenCalledWith('tok', 'Kitchen iPad');
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ book }));
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('opens the book when the server could not be asked', async () => {
    useSession.setState({ connections: [chris] });
    mockMe.mockRejectedValueOnce(new TimeoutError(15000));
    expect(await pairWith(bookScan)).toBe('paired');
    expect(mockEnd).toHaveBeenCalledWith('srv-1.1', book);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('exchanges for "Add someone", which switches to that person', async () => {
    useSession.setState({ connections: [chris] });
    setConnectForNewProfile(true);
    mockExchange.mockResolvedValue(session);
    expect(await pairWith(bookScan)).toBe('paired');
    expect(mockMe).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ book }));
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('reads the connections again first when they never loaded', async () => {
    mockHydrateFailed = true;
    const hydrate = jest.fn(async () => useSession.setState({ connections: [chris] }));
    useSession.setState({ hydrate });
    expect(await pairWith(bookScan)).toBe('paired');
    expect(hydrate).toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalledWith('srv-1.1', book);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('exchanges and ends on the book for anyone else, or a link without its user', async () => {
    useSession.setState({ connections: [chris] });
    mockExchange.mockResolvedValue(session);
    for (const s of [
      { ...bookScan, userId: 2 },
      { ...bookScan, serverId: 'srv-2' },
    ]) {
      expect(await pairWith(s)).toBe('paired');
      expect(mockFinish).toHaveBeenLastCalledWith(expect.objectContaining({ book }));
    }
    const { userId: _drop, ...noUser } = bookScan;
    expect(await pairWith(noUser)).toBe('paired');
    // A plain pairing link never skips, even for a user signed in there.
    expect(await pairWith({ ...scan, serverId: 'srv-1', userId: 1 })).toBe('paired');
    expect(mockExchange).toHaveBeenCalledTimes(4);
    expect(mockEnd).not.toHaveBeenCalled();
  });
});
