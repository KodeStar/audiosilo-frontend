import { ApiError } from '@/api/client';
import type { PairingPayload } from '@/api/types';
import type { Connection } from '@/stores/session';

const mockRead = jest.fn();
const mockSendPair = jest.fn();
const mockSendBook = jest.fn();
const mockSendRemove = jest.fn();
jest.mock('./link', () => ({
  watchLink: {
    supported: true,
    read: () => mockRead(),
    subscribe: () => {},
    sendPair: (m: unknown) => mockSendPair(m),
    sendBook: (m: unknown) => mockSendBook(m),
    sendRemove: (m: unknown) => mockSendRemove(m),
  },
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'iPhone' }));

/* eslint-disable import/first */
import { removeFromWatch, sendBookToWatch, setUpWatch, WatchSendError } from './send';
import { ledgerRows, useWatchLedger } from './watch-ledger';
import { refreshWatch, useWatchStore } from './watch-store';
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
  watchId: null,
  transfers: [],
  state: {
    signed_in: true,
    server_id: 'srv',
    user_id: userId,
    books: [],
    unsent_events: 0,
    couldnt_sync: 0,
  },
});
const blank = { paired: true, installed: true, state: null, watchId: null, transfers: [] };

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

  it('counts the expiry from before the request, not from the answer', async () => {
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
    await expect(sendBookToWatch(api, connection, 3, book)).resolves.toEqual({ signInLeft: false });
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
    await expect(sending).resolves.toEqual({ signInLeft: true });
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
    // The sign-in is still to do on the watch, so the listener is told again.
    await expect(sendBookToWatch(api, connection, 3, book)).resolves.toEqual({ signInLeft: true });
    expect(api.pair).toHaveBeenCalledTimes(1);
    expect(mockSendBook).toHaveBeenCalledTimes(2);
  });

  it('shares one pair between two books sent at once, both behind it', async () => {
    let release!: () => void;
    mockSendPair.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const both = Promise.all([
      sendBookToWatch(api, connection, 3, book),
      sendBookToWatch(api, connection, 3, { ...book, rel_path: 'A/C' }),
    ]);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockSendBook).not.toHaveBeenCalled();
    release();
    await both;
    expect(api.pair).toHaveBeenCalledTimes(1);
    expect(mockSendPair).toHaveBeenCalledTimes(1);
    expect(mockSendBook).toHaveBeenCalledTimes(2);
  });

  it('mints again after a failed pair: a refusal is not shared with the next send', async () => {
    api.pair.mockRejectedValueOnce(new ApiError(500, 'no'));
    await expect(sendBookToWatch(api, connection, 3, book)).rejects.toBeInstanceOf(ApiError);
    await sendBookToWatch(api, connection, 3, book);
    expect(api.pair).toHaveBeenCalledTimes(2);
    expect(mockSendBook).toHaveBeenCalledTimes(1);
  });

  it('mints again after a pair for another account took the place of this one', async () => {
    const other = { ...connection, id: 'srv.8', user: { id: 8, username: 'bo' } } as Connection;
    await sendBookToWatch(api, connection, 3, book);
    await sendBookToWatch(api, other, 3, book);
    expect(Object.keys(useWatchStore.getState().pairUntil)).toEqual(['srv.8']);
    await sendBookToWatch(api, connection, 3, book);
    expect(api.pair).toHaveBeenCalledTimes(3);
  });

  it('mints again once the watch signed in with the pair and has since left the account', async () => {
    await sendBookToWatch(api, connection, 3, book);
    mockRead.mockResolvedValue(signedInStatus(7));
    await refreshWatch();
    expect(useWatchStore.getState().pairUntil).toEqual({});
    mockRead.mockResolvedValue(blank);
    await sendBookToWatch(api, connection, 3, book);
    expect(api.pair).toHaveBeenCalledTimes(2);
  });

  it('keeps a pair on its way while the watch still says it is signed in elsewhere', async () => {
    await sendBookToWatch(api, connection, 3, book);
    mockRead.mockResolvedValue(signedInStatus(8));
    await refreshWatch();
    expect(useWatchStore.getState().pairUntil['srv.7']).toBe(NOW + 600_000);
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

describe('the ledger', () => {
  const W = 'watch-1';
  const here = { ...signedInStatus(7), watchId: W };
  const rows = () => ledgerRows(useWatchLedger.getState().ledger, W, 'srv.7');

  beforeEach(() => {
    useWatchLedger.setState({ ledger: {} });
    useWatchStore.setState({ status: here, pairUntil: {} });
    mockRead.mockResolvedValue(here);
    mockSendRemove.mockReset().mockResolvedValue(undefined);
  });

  it('holds the row from the moment Send is tapped, not yet handed over', async () => {
    let release = () => {};
    mockSendBook.mockReturnValue(new Promise<void>((r) => (release = r)));
    const sending = sendBookToWatch(api, connection, 3, book);
    expect(rows()).toMatchObject([{ library_id: 3, path: 'A/B', title: 'B', handed_over: false }]);
    await Promise.resolve();
    release();
    await sending;
    expect(rows()).toMatchObject([{ path: 'A/B', handed_over: true, sent_at: NOW }]);
  });

  it('takes the row back when nothing was sent', async () => {
    mockSendBook.mockRejectedValue(new Error('ERR_NO_WATCH'));
    await expect(sendBookToWatch(api, connection, 3, book)).rejects.toBeInstanceOf(WatchSendError);
    expect(rows()).toEqual([]);
  });

  it('puts back what was there when a send again fails', async () => {
    await sendBookToWatch(api, connection, 3, book);
    const before = rows();
    mockSendBook.mockRejectedValue(new Error('ERR_NO_WATCH'));
    await expect(sendBookToWatch(api, connection, 3, book)).rejects.toBeInstanceOf(WatchSendError);
    expect(rows()).toEqual(before);
  });

  it('keeps no row when the watch cannot be named', async () => {
    useWatchStore.setState({ status: signedInStatus(7) });
    mockRead.mockResolvedValue(signedInStatus(7));
    await sendBookToWatch(api, connection, 3, book);
    expect(useWatchLedger.getState().ledger).toEqual({});
  });

  it('names the row once the session has answered, on a cold start', async () => {
    useWatchStore.setState({ status: blank });
    await sendBookToWatch(api, connection, 3, book);
    expect(rows()).toMatchObject([{ path: 'A/B', handed_over: true }]);
  });

  it('sends a remove and says so, the row kept while it is on its way', async () => {
    await sendBookToWatch(api, connection, 3, book);
    mockRead.mockResolvedValue({
      ...here,
      transfers: [{ type: 'remove', account: 'srv.7', library_id: 3, path: 'A/B', failed: false }],
    });
    await removeFromWatch(connection, 3, { path: 'A/B', title: 'B' });
    expect(mockSendRemove).toHaveBeenCalledWith({
      v: 1,
      type: 'remove',
      server_id: 'srv',
      user_id: 7,
      library_id: 3,
      path: 'A/B',
    });
    expect(rows()).toMatchObject([{ path: 'A/B', remove_at: NOW }]);
  });

  it('notes nothing when the link refuses a remove', async () => {
    await sendBookToWatch(api, connection, 3, book);
    const before = rows();
    mockSendRemove.mockRejectedValue(new Error('ERR_NO_WATCH'));
    await expect(
      removeFromWatch(connection, 3, { path: 'A/B', title: 'B' }),
    ).rejects.toBeInstanceOf(WatchSendError);
    expect(rows()).toEqual(before);
  });

  it('starts afresh when a book is sent again after a Remove', async () => {
    await sendBookToWatch(api, connection, 3, book);
    await removeFromWatch(connection, 3, { path: 'A/B', title: 'B' });
    await sendBookToWatch(api, connection, 3, book);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].remove_at).toBeUndefined();
    expect(rows()[0].handed_over).toBe(true);
  });
});
