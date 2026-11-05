import { ApiError } from '@/api/client';
import type { PairingPayload } from '@/api/types';
import type { Connection } from '@/stores/session';

const mockRead = jest.fn();
const mockSendPair = jest.fn();
const mockSendBook = jest.fn();
jest.mock('./link', () => ({
  watchLink: {
    supported: true,
    read: () => mockRead(),
    subscribe: () => () => {},
    sendPair: (m: unknown) => mockSendPair(m),
    sendBook: (m: unknown) => mockSendBook(m),
  },
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'iPhone' }));

/* eslint-disable import/first */
import { sendBookToWatch, setUpWatch, WatchSendError } from './send';
import { useWatchStore } from './watch-store';
/* eslint-enable import/first */

const connection = {
  id: 'srv.7',
  serverId: 'srv',
  serverUrl: 'https://books.example',
  name: 'Hearthside',
  token: 't',
  user: { id: 7, username: 'ada' },
} as Connection;
const payload = {
  server_name: 'Hearthside',
  base_url: 'https://books.example',
  pairing_token: 'tok',
} as PairingPayload;
const book = { rel_path: 'A/B', title: 'B', author: 'A' };
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const signedInStatus = (userId: number) => ({
  paired: true,
  installed: true,
  state: {
    signed_in: true,
    server_id: 'srv',
    user_id: userId,
    app_version: '2.6.0',
    books: [],
    unsent_events: 0,
    couldnt_sync: 0,
  },
});
const blank = { paired: true, installed: true, state: null };

let api: { pair: jest.Mock };

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  useWatchStore.setState({ status: blank, pairUntil: {} });
  api = { pair: jest.fn(async () => payload) };
  mockRead.mockReset().mockResolvedValue(blank);
  mockSendPair.mockReset().mockResolvedValue(undefined);
  mockSendBook.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('setUpWatch', () => {
  it('mints a 10-minute token and sends it, noting when it runs out', async () => {
    await setUpWatch(api, connection);
    expect(api.pair).toHaveBeenCalledWith({ ttlSeconds: 600 });
    const message = mockSendPair.mock.calls[0][0];
    expect(message.pairing_token).toBe('tok');
    expect(message.expires_at).toBe(new Date(NOW + 600_000).toISOString());
    expect(useWatchStore.getState().pairUntil['srv.7']).toBe(NOW + 600_000);
  });

  it('counts the expiry from before the request, never later than the server', async () => {
    api.pair.mockImplementation(async () => {
      jest.setSystemTime(NOW + 5_000);
      return payload;
    });
    await setUpWatch(api, connection);
    expect(mockSendPair.mock.calls[0][0].expires_at).toBe(new Date(NOW + 600_000).toISOString());
  });

  it('mints a new token every time', async () => {
    await setUpWatch(api, connection);
    await setUpWatch(api, connection);
    expect(api.pair).toHaveBeenCalledTimes(2);
  });

  it('notes nothing when the server refuses', async () => {
    const refused = new ApiError(403, 'no', 'kid_account');
    api.pair.mockRejectedValue(refused);
    await expect(setUpWatch(api, connection)).rejects.toBe(refused);
    expect(mockSendPair).not.toHaveBeenCalled();
    expect(useWatchStore.getState().pairUntil['srv.7']).toBeUndefined();
  });

  it('says the watch failed when the link does, and notes nothing', async () => {
    mockSendPair.mockRejectedValue(new Error('ERR_NO_WATCH'));
    await expect(setUpWatch(api, connection)).rejects.toBeInstanceOf(WatchSendError);
    expect(useWatchStore.getState().pairUntil['srv.7']).toBeUndefined();
  });
});

describe('sendBookToWatch', () => {
  it('sends only the book to a watch signed in here', async () => {
    mockRead.mockResolvedValue(signedInStatus(7));
    await expect(sendBookToWatch(api, connection, 3, book)).resolves.toEqual({ paired: false });
    expect(api.pair).not.toHaveBeenCalled();
    expect(mockSendPair).not.toHaveBeenCalled();
    expect(mockSendBook.mock.calls[0][0]).toMatchObject({
      type: 'book',
      server_id: 'srv',
      user_id: 7,
      library_id: 3,
      path: 'A/B',
    });
  });

  it('sends the pair first, and the book only once it is out', async () => {
    const order: string[] = [];
    let release!: () => void;
    mockSendPair.mockImplementation(async () => {
      order.push('pair');
      await new Promise<void>((resolve) => (release = resolve));
    });
    mockSendBook.mockImplementation(async () => {
      order.push('book');
    });
    const sending = sendBookToWatch(api, connection, 3, book);
    await jest.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['pair']);
    release();
    await expect(sending).resolves.toEqual({ paired: true });
    expect(order).toEqual(['pair', 'book']);
  });

  it('brings a pair to a watch signed in to another account', async () => {
    mockRead.mockResolvedValue(signedInStatus(8));
    await sendBookToWatch(api, connection, 3, book);
    expect(mockSendPair).toHaveBeenCalledTimes(1);
  });

  it('reads the watch first: the state is what the session kept, even on a cold start', async () => {
    useWatchStore.setState({ status: signedInStatus(7) });
    mockRead.mockResolvedValue(blank);
    await sendBookToWatch(api, connection, 3, book);
    expect(mockSendPair).toHaveBeenCalledTimes(1);
  });

  it('does not mint again for the next book while a pair is on its way', async () => {
    await sendBookToWatch(api, connection, 3, book);
    await expect(sendBookToWatch(api, connection, 3, book)).resolves.toEqual({ paired: false });
    expect(api.pair).toHaveBeenCalledTimes(1);
    expect(mockSendBook).toHaveBeenCalledTimes(2);
  });

  it('mints again once the pair sent has run out', async () => {
    await sendBookToWatch(api, connection, 3, book);
    jest.setSystemTime(NOW + 601_000);
    await sendBookToWatch(api, connection, 3, book);
    expect(api.pair).toHaveBeenCalledTimes(2);
  });

  it('sends no book when the pair could not be minted', async () => {
    api.pair.mockRejectedValue(new ApiError(403, 'no'));
    await expect(sendBookToWatch(api, connection, 3, book)).rejects.toBeInstanceOf(ApiError);
    expect(mockSendBook).not.toHaveBeenCalled();
  });

  it('keeps the last answer when the session does not answer', async () => {
    useWatchStore.setState({ status: signedInStatus(7) });
    mockRead.mockRejectedValue(new Error('no session'));
    await sendBookToWatch(api, connection, 3, book);
    expect(mockSendPair).not.toHaveBeenCalled();
  });
});
