import AsyncStorage from '@react-native-async-storage/async-storage';

import { WATCH_LEDGER_KEY } from '@/lib/storage-keys';

import type { LedgerRow } from './watch-rows';

const mockRemoved: ((id: string) => void | Promise<void>)[] = [];
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: (fn: (id: string) => void | Promise<void>) => {
    mockRemoved.push(fn);
    return () => {};
  },
}));

const book = { library_id: 1, path: 'A/B', title: 'Book' };
const A = 'srv.7';
const W = 'watch-1';

type Ledger = typeof import('./watch-ledger');

/** A fresh module, as a cold start has. */
function load(): Ledger {
  let m: Ledger | undefined;
  jest.isolateModules(() => {
    m = jest.requireActual('./watch-ledger');
  });
  return m!;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const rows = (m: Ledger, watchId: string | null = W, account = A): LedgerRow[] =>
  m.ledgerRows(m.useWatchLedger.getState().ledger, watchId, account);

beforeEach(async () => {
  mockRemoved.length = 0;
  await AsyncStorage.clear();
});

describe('the ledger', () => {
  it('survives a cold start', async () => {
    const first = load();
    await first.hydrateLedger();
    first.noteSending(W, A, book, 100);
    first.noteHandedOver(W, A, book);
    await flush();

    const second = load();
    await second.hydrateLedger();
    expect(rows(second)).toEqual([
      { library_id: 1, path: 'A/B', title: 'Book', sent_at: 100, handed_over: true },
    ]);
  });

  it('reads a damaged document as what can be read of it', async () => {
    await AsyncStorage.setItem(
      WATCH_LEDGER_KEY,
      JSON.stringify({
        [W]: {
          [A]: [{ library_id: 1, path: 'A/B', title: 'Book', sent_at: 1 }, { path: 'bad' }, 7],
          other: 'nope',
        },
        junk: 3,
      }),
    );
    const m = load();
    await m.hydrateLedger();
    expect(rows(m).map((r) => r.path)).toEqual(['A/B']);
  });

  it('keeps a row to its watch and its account', async () => {
    const m = load();
    await m.hydrateLedger();
    m.noteSending(W, A, book, 100);
    expect(rows(m, 'watch-2')).toEqual([]);
    expect(rows(m, W, 'srv.8')).toEqual([]);
    expect(rows(m, null)).toEqual([]);
    expect(rows(m)).toHaveLength(1);
  });

  it('settles only the watch the word is from', async () => {
    const m = load();
    await m.hydrateLedger();
    m.noteSending(W, A, book, 100);
    m.noteHandedOver(W, A, book);
    m.noteRemoving(W, A, book, 200);
    m.noteSending('watch-2', A, book, 100);
    m.noteHandedOver('watch-2', A, book);
    m.noteRemoving('watch-2', A, book, 200);
    const empty = {
      signed_in: true,
      server_id: 'srv',
      user_id: 7,
      books: [],
      unsent_events: 0,
      couldnt_sync: 0,
    };
    m.applyWatchStatus({ watchId: W, state: empty, transfers: [] }, 300);
    expect(rows(m)).toEqual([]);
    expect(rows(m, 'watch-2')).toHaveLength(1);
    // A status that can't name its watch settles nothing.
    m.applyWatchStatus({ watchId: null, state: empty, transfers: [] }, 300);
    expect(rows(m, 'watch-2')).toHaveLength(1);
  });

  it('marks a book the watch never had a row for when it is removed', async () => {
    const m = load();
    await m.hydrateLedger();
    m.noteRemoving(W, A, book, 200);
    expect(rows(m)).toEqual([
      {
        library_id: 1,
        path: 'A/B',
        title: 'Book',
        sent_at: 200,
        handed_over: true,
        seen: true,
        remove_at: 200,
      },
    ]);
  });

  it('clears a refusal when asked again, and when sent again', async () => {
    const m = load();
    await m.hydrateLedger();
    m.noteSending(W, A, book, 100);
    m.noteHandedOver(W, A, book);
    m.noteRemoving(W, A, book, 200);
    m.applyWatchStatus({
      watchId: W,
      state: { signed_in: false, books: [], unsent_events: 0, couldnt_sync: 0 },
      transfers: [],
    });
    expect(rows(m)[0].remove_refused).toBe(true);
    m.noteRemoving(W, A, book, 300);
    expect(rows(m)[0]).toMatchObject({ remove_at: 300 });
    expect(rows(m)[0].remove_refused).toBeUndefined();
    m.noteSending(W, A, book, 400);
    expect(rows(m)[0].remove_at).toBeUndefined();
    expect(rows(m)[0].handed_over).toBe(false);
  });

  it('forgets a row on request', async () => {
    const m = load();
    await m.hydrateLedger();
    m.noteSending(W, A, book, 100);
    m.forgetRow(W, A, book);
    expect(rows(m)).toEqual([]);
  });

  it('puts back what a failed send replaced, or nothing', async () => {
    const m = load();
    await m.hydrateLedger();
    const none = m.noteSending(W, A, book, 100);
    m.restoreRow(W, A, book, none);
    expect(rows(m)).toEqual([]);
    m.noteSending(W, A, book, 100);
    m.noteHandedOver(W, A, book);
    const before = m.noteSending(W, A, book, 200);
    m.restoreRow(W, A, book, before);
    expect(rows(m)).toMatchObject([{ sent_at: 100, handed_over: true }]);
  });

  it('drops the rows of a removed connection, on every watch', async () => {
    const m = load();
    await m.hydrateLedger();
    m.followConnectionRemovals();
    m.noteSending(W, A, book, 100);
    m.noteSending('watch-2', A, book, 100);
    m.noteSending(W, 'srv.8', book, 100);
    await mockRemoved[0]('srv.7');
    expect(rows(m)).toEqual([]);
    expect(rows(m, 'watch-2')).toEqual([]);
    expect(rows(m, W, 'srv.8')).toHaveLength(1);
  });

  it('drops the rows of a connection removed before the ledger was read', async () => {
    await AsyncStorage.setItem(
      WATCH_LEDGER_KEY,
      JSON.stringify({ [W]: { [A]: [{ ...book, sent_at: 1, handed_over: true }] } }),
    );
    const m = load();
    m.followConnectionRemovals();
    await mockRemoved[0](A);
    expect(rows(m)).toEqual([]);
    expect(JSON.parse((await AsyncStorage.getItem(WATCH_LEDGER_KEY)) ?? '{}')).toEqual({ [W]: {} });
  });

  it('takes a legacy connection id for every account of that server', async () => {
    const m = load();
    await m.hydrateLedger();
    m.followConnectionRemovals();
    m.noteSending(W, A, book, 100);
    m.noteSending(W, 'other.7', book, 100);
    await mockRemoved[0]('srv');
    expect(rows(m)).toEqual([]);
    expect(rows(m, W, 'other.7')).toHaveLength(1);
  });

  describe('another watch never heard from again', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 200 * DAY;
    const word = (watchId: string) => ({
      watchId,
      state: { signed_in: false, books: [], unsent_events: 0, couldnt_sync: 0 },
      transfers: [],
    });

    it('drops its rows once every one is over 90 days old, and keeps that on disk', async () => {
      const m = load();
      await m.hydrateLedger();
      m.noteSending('old', A, book, now - 91 * DAY);
      m.noteSending('old', 'srv.8', book, now - 95 * DAY);
      m.noteSending(W, A, book, now - 100 * DAY);
      m.applyWatchStatus(word(W), now);
      expect(Object.keys(m.useWatchLedger.getState().ledger)).toEqual([W]);
      // The watch the word is from keeps its rows, however old: its own word settles them.
      expect(rows(m)).toHaveLength(1);
      await flush();
      expect(
        Object.keys(JSON.parse((await AsyncStorage.getItem(WATCH_LEDGER_KEY)) ?? '{}')),
      ).toEqual([W]);
    });

    it('keeps them while one row was asked about within 90 days, a Remove included', async () => {
      const m = load();
      await m.hydrateLedger();
      m.noteSending('old', A, book, now - 120 * DAY);
      m.noteSending('recent', A, book, now - 120 * DAY);
      m.noteRemoving('recent', A, book, now - 10 * DAY);
      m.noteSending('old', 'srv.8', book, now - 89 * DAY);
      m.applyWatchStatus(word(W), now);
      expect(Object.keys(m.useWatchLedger.getState().ledger).sort()).toEqual(['old', 'recent']);
    });
  });

  it('clears a failed send once the link takes the book again', async () => {
    const m = load();
    await m.hydrateLedger();
    m.noteSending(W, A, book, 100);
    m.noteHandedOver(W, A, book);
    m.applyWatchStatus(
      {
        watchId: W,
        state: null,
        transfers: [{ type: 'book', account: A, library_id: 1, path: 'A/B', failed: true }],
      },
      200,
    );
    // Never told anything by the watch: nothing is concluded, the failure included.
    expect(rows(m)[0].send_failed).toBeUndefined();
    const signedIn = {
      signed_in: true,
      server_id: 'srv',
      user_id: 7,
      books: [],
      unsent_events: 0,
      couldnt_sync: 0,
    };
    m.applyWatchStatus(
      {
        watchId: W,
        state: signedIn,
        transfers: [{ type: 'book', account: A, library_id: 1, path: 'A/B', failed: true }],
      },
      200,
    );
    expect(rows(m)[0].send_failed).toBe(true);
    m.noteSending(W, A, book, 300);
    m.noteHandedOver(W, A, book);
    expect(rows(m)[0].send_failed).toBeUndefined();
  });

  it("clears a failed Remove when asked again, keeping the first one's time", async () => {
    const m = load();
    await m.hydrateLedger();
    m.noteRemoving(W, A, book, 200);
    changeFailed(m);
    expect(rows(m)[0].remove_failed).toBe(true);
    m.noteRemoving(W, A, book, 300, 200);
    expect(rows(m)[0]).toMatchObject({ remove_at: 300, remove_asked_at: 200 });
    expect(rows(m)[0].remove_failed).toBeUndefined();
    // A Remove that is a new one carries no first time.
    m.noteRemoving(W, A, book, 400);
    expect(rows(m)[0].remove_asked_at).toBeUndefined();
  });
});

/** The watch lists the book still, and the link says the Remove could not go. */
function changeFailed(m: Ledger) {
  m.applyWatchStatus(
    {
      watchId: W,
      state: {
        signed_in: true,
        server_id: 'srv',
        user_id: 7,
        books: [{ ...book, state: 'ready' }],
        unsent_events: 0,
        couldnt_sync: 0,
      },
      transfers: [{ type: 'remove', account: A, library_id: 1, path: 'A/B', failed: true }],
    },
    250,
  );
}
