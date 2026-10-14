import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockExchange = jest.fn();
// The base URL of each exchange, in order.
const mockExchangedAt: string[] = [];
jest.mock('@/api/client', () => {
  const actual = jest.requireActual('@/api/client');
  return {
    ...actual,
    ApiClient: class {
      base: string;
      constructor(base: string) {
        this.base = base;
      }
      exchange = (...a: unknown[]) => {
        mockExchangedAt.push(this.base);
        return mockExchange(...a);
      };
      serverInfo = async () => ({ name: 'Hearthside' });
    },
  };
});
const mockFinish = jest.fn();
jest.mock('./finish-connect', () => ({ finishConnect: (...a: unknown[]) => mockFinish(...a) }));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Kitchen iPad' }));
// The tokenless `GET /server` probe of the home address: the server_id it answers.
const mockProbe = jest.fn();
jest.mock('@/api/server-id-probe', () => ({
  probeServerId: (url: string) => mockProbe(url),
}));

/* eslint-disable import/first */
import { ApiError, TimeoutError } from '@/api/client';

import { useLinkPairing } from './use-pairing';
/* eslint-enable import/first */

const scan = { base: 'https://books.example', token: 'tok' };

/** The error a refused exchange `e` of `link` leaves, in words. */
async function errorFor(e: unknown, link: typeof scan = scan): Promise<string | null> {
  mockExchange.mockRejectedValue(e);
  const { result } = await renderHook(() => useLinkPairing());
  let paired: boolean | undefined;
  await act(async () => {
    paired = await result.current.pair(link);
  });
  expect(paired).toBe(false);
  expect(result.current.pairing).toBe(false);
  return result.current.error;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExchangedAt.length = 0;
});

describe('useLinkPairing', () => {
  it('pairs and finishes the connect flow with the server name', async () => {
    const session = { token: 's', user: { id: 1, username: 'evie' }, server_id: 'a' };
    mockExchange.mockResolvedValue(session);
    const { result } = await renderHook(() => useLinkPairing());
    await act(async () => {
      expect(await result.current.pair(scan)).toBe(true);
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
    let paired: boolean | undefined;
    await act(async () => {
      paired = await result.current.pair(s);
    });
    return { paired, error: result.current.error };
  }

  it("exchanges at the link's plain-http home when its https base can't connect and home is the link's server", async () => {
    mockExchange.mockRejectedValueOnce(down()).mockResolvedValueOnce(session);
    expect((await pairWith(homeScan)).paired).toBe(true);
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
    expect((await pairWith(homeScan)).paired).toBe(true);
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
      expect(paired).toBe(false);
      expect(mockExchangedAt).toEqual([BASE]);
      expect(error).toMatch(/^Couldn't reach the server/);
    }
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("never falls back for a link without the server's id (an older server)", async () => {
    mockExchange.mockRejectedValue(down());
    const { serverId: _drop, ...noSid } = homeScan;
    expect((await pairWith(noSid)).paired).toBe(false);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockExchangedAt).toEqual([BASE]);
  });

  it("keeps no session another server issued at home, and says the base couldn't be reached", async () => {
    mockExchange
      .mockRejectedValueOnce(down())
      .mockResolvedValueOnce({ ...session, server_id: 'srv-other' });
    const { paired, error } = await pairWith(homeScan);
    expect(paired).toBe(false);
    expect(mockExchangedAt).toEqual([BASE, HOME]);
    expect(error).toMatch(/^Couldn't reach the server/);
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it('does not fall back when the base answered, and reports what it said', async () => {
    mockExchange.mockRejectedValueOnce(new ApiError(401, 'expired'));
    const { paired, error } = await pairWith(homeScan);
    expect(paired).toBe(false);
    expect(mockExchangedAt).toEqual([BASE]);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(error).toMatch(/expired or was already used/);
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("says the base couldn't be reached when the home can't either", async () => {
    mockExchange.mockRejectedValue(down());
    const { paired, error } = await pairWith(homeScan);
    expect(paired).toBe(false);
    expect(mockExchangedAt).toEqual([BASE, HOME]);
    expect(error).toMatch(/^Couldn't reach the server/);
  });

  it('names no certificate for a failure after the exchange (storing the connection)', async () => {
    mockExchange.mockResolvedValueOnce(session);
    mockFinish.mockRejectedValueOnce(new Error('could not store'));
    const { paired, error } = await pairWith(homeScan);
    expect(paired).toBe(false);
    expect(error).toBe('Could not reach the server to finish pairing.');
  });

  it("says what the home's server answered when it answered", async () => {
    mockExchange.mockRejectedValueOnce(down()).mockRejectedValueOnce(new ApiError(500, 'boom'));
    expect((await pairWith(homeScan)).error).toMatch(/^The server couldn't finish pairing/);
    expect(mockFinish).not.toHaveBeenCalled();
  });
});
