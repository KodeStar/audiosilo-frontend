import { act, renderHook } from '@testing-library/react-native';

const mockExchange = jest.fn();
jest.mock('@/api/client', () => {
  const actual = jest.requireActual('@/api/client');
  return {
    ...actual,
    ApiClient: class {
      exchange = (...a: unknown[]) => mockExchange(...a);
      serverInfo = async () => ({ name: 'Hearthside' });
    },
  };
});
const mockFinish = jest.fn();
jest.mock('./finish-connect', () => ({ finishConnect: (...a: unknown[]) => mockFinish(...a) }));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Kitchen iPad' }));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';

import { useLinkPairing } from './use-pairing';
/* eslint-enable import/first */

const scan = { base: 'https://books.example', token: 'tok' };

/** The error a refused exchange `e` leaves, in words. */
async function errorFor(e: unknown): Promise<string | null> {
  mockExchange.mockRejectedValue(e);
  const { result } = await renderHook(() => useLinkPairing());
  let paired: boolean | undefined;
  await act(async () => {
    paired = await result.current.pair(scan);
  });
  expect(paired).toBe(false);
  expect(result.current.pairing).toBe(false);
  return result.current.error;
}

beforeEach(() => jest.clearAllMocks());

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
      'Could not reach the server to finish pairing.',
    );
  });
});
