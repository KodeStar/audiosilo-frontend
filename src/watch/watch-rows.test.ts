import type { WatchState, WatchTransfer } from './watch-model';
import {
  dropRow,
  type LedgerRow,
  parseLedgerRow,
  putRow,
  reconcileRows,
  rowActions,
  WATCH_HOLD_MS,
  watchRows,
} from './watch-rows';

const NOW = 1_000_000_000;
const ACCOUNT = 'srv.7';
const sent = (p: Partial<LedgerRow> = {}): LedgerRow => ({
  library_id: 1,
  path: 'A/B',
  title: 'Book',
  sent_at: NOW - 1000,
  handed_over: true,
  ...p,
});
const state = (p: Partial<WatchState> = {}): WatchState => ({
  signed_in: true,
  server_id: 'srv',
  user_id: 7,
  books: [],
  unsent_events: 0,
  couldnt_sync: 0,
  ...p,
});
const listed = { library_id: 1, path: 'A/B', title: 'From the watch', state: 'preparing' } as const;
const transfer = (type: WatchTransfer['type'], p: Partial<WatchTransfer> = {}): WatchTransfer => ({
  type,
  account: ACCOUNT,
  library_id: 1,
  path: 'A/B',
  failed: false,
  ...p,
});
const otherAccount = state({ user_id: 8, books: [listed] });
const signedOut = state({ signed_in: false, server_id: undefined, user_id: undefined });

const phase = (
  row: LedgerRow,
  s: WatchState | null,
  transfers: WatchTransfer[] = [],
  now = NOW,
  account = ACCOUNT,
) => watchRows([row], account, { state: s, transfers }, now)[0].phase;

describe('watchRows: sent, and not listed', () => {
  it('has not been delivered while the link has not got it, or the session still holds it', () => {
    expect(phase(sent({ handed_over: false }), state())).toBe('undelivered');
    // The app died sending it (read back at launch): nothing is on its way, and it can be sent again.
    const cut = parseLedgerRow({ ...sent(), handed_over: false });
    expect(cut?.send_cut_off).toBe(true);
    expect(phase(cut as LedgerRow, state())).toBe('send-failed');
    expect(phase(sent(), state(), [transfer('book')])).toBe('undelivered');
  });

  it('is delivered once the session holds it no more', () => {
    expect(phase(sent(), state())).toBe('delivered');
    // A watch that has never said anything: the app has yet to open.
    expect(phase(sent(), null)).toBe('delivered');
  });

  it('waits for a sign-in on a watch signed out or on another account', () => {
    expect(phase(sent(), signedOut)).toBe('waiting-sign-in');
    expect(phase(sent(), otherAccount)).toBe('waiting-sign-in');
  });

  it('says when the system could not deliver it', () => {
    expect(phase(sent(), state(), [transfer('book', { failed: true })])).toBe('send-failed');
  });

  it('stops claiming progress after the watch hold limit', () => {
    const row = sent({ sent_at: NOW - WATCH_HOLD_MS });
    expect(phase(row, state())).toBe('stale');
    expect(phase(row, signedOut)).toBe('stale');
    expect(phase(row, state(), [transfer('book')])).toBe('stale');
    expect(phase(row, null)).toBe('stale');
    expect(phase(sent({ sent_at: NOW - WATCH_HOLD_MS + 1 }), state())).toBe('delivered');
  });

  it('ignores a transfer of the same book for another account or library', () => {
    expect(phase(sent(), state(), [transfer('book', { account: 'srv.8' })])).toBe('delivered');
    expect(phase(sent(), state(), [transfer('book', { library_id: 2 })])).toBe('delivered');
  });
});

describe('watchRows: what the watch lists', () => {
  it('wins over the ledger', () => {
    const rows = watchRows(
      [sent()],
      ACCOUNT,
      { state: state({ books: [listed] }), transfers: [] },
      NOW,
    );
    expect(rows).toEqual([
      {
        library_id: 1,
        path: 'A/B',
        title: 'From the watch',
        author: undefined,
        bytes: undefined,
        phase: 'preparing',
      },
    ]);
  });

  it('lists a book the phone never sent, with its size once ready', () => {
    const own = { library_id: 2, path: 'C/D', title: 'Own', state: 'ready', bytes: 42 } as const;
    expect(watchRows([], ACCOUNT, { state: state({ books: [own] }), transfers: [] }, NOW)).toEqual([
      { library_id: 2, path: 'C/D', title: 'Own', author: undefined, bytes: 42, phase: 'ready' },
    ]);
  });

  it('never shows under another account, however the rows read', () => {
    expect(watchRows([], ACCOUNT, { state: otherAccount, transfers: [] }, NOW)).toEqual([]);
    expect(
      watchRows([], 'srv.8', { state: state({ books: [listed] }), transfers: [] }, NOW),
    ).toEqual([]);
    expect(
      watchRows([], ACCOUNT, { state: { ...otherAccount, signed_in: false }, transfers: [] }, NOW),
    ).toEqual([]);
    expect(watchRows([], ACCOUNT, { state: null, transfers: [] }, NOW)).toEqual([]);
  });

  it('never shows a server with the same user id as this account', () => {
    const elsewhere = state({ server_id: 'other', books: [listed] });
    expect(watchRows([], ACCOUNT, { state: elsewhere, transfers: [] }, NOW)).toEqual([]);
  });

  it('puts what the watch lists first, then what was sent', () => {
    const rows = watchRows(
      [sent({ path: 'Sent' }), sent()],
      ACCOUNT,
      { state: state({ books: [listed] }), transfers: [] },
      NOW,
    );
    expect(rows.map((r) => r.path)).toEqual(['A/B', 'Sent']);
  });
});

describe('watchRows: removing', () => {
  const removing = sent({ remove_at: NOW - 1000, seen: true });
  const on = state({ books: [listed] });

  it('says it has not reached the watch while the session holds it, and does not claim it finished', () => {
    expect(phase(removing, on, [transfer('remove')])).toBe('removing-undelivered');
    expect(phase(removing, state(), [transfer('remove')])).toBe('removing-undelivered');
  });

  it('then asks for the watch app while the watch still lists it', () => {
    expect(phase(removing, on)).toBe('removing');
  });

  it('says when the system could not deliver it', () => {
    expect(phase(removing, on, [transfer('remove', { failed: true })])).toBe('remove-failed');
  });

  it('stops saying removing after the hold limit, the row is the watch’s again', () => {
    expect(phase(sent({ remove_at: NOW - WATCH_HOLD_MS, seen: true }), on)).toBe('preparing');
  });

  it('explains a refusal', () => {
    expect(phase(sent({ remove_refused: true }), signedOut)).toBe('remove-refused');
  });
});

describe('rowActions', () => {
  it('offers nothing while removing', () => {
    expect(rowActions('removing')).toEqual({ remove: false, sendAgain: false, dismiss: false });
    expect(rowActions('removing-undelivered')).toEqual({
      remove: false,
      sendAgain: false,
      dismiss: false,
    });
  });

  it('offers Send again where nothing else will move it', () => {
    expect(rowActions('stale').sendAgain).toBe(true);
    expect(rowActions('send-failed').sendAgain).toBe(true);
    expect(rowActions('failed').sendAgain).toBe(true);
    expect(rowActions('ready').sendAgain).toBe(false);
    expect(rowActions('delivered').sendAgain).toBe(false);
  });

  it('gives a refused row a way out, and a failed Remove another try', () => {
    expect(rowActions('remove-refused')).toEqual({
      remove: false,
      sendAgain: false,
      dismiss: true,
    });
    expect(rowActions('remove-failed').remove).toBe(true);
    expect(rowActions('ready').remove).toBe(true);
  });
});

describe('reconcileRows', () => {
  const settle = (rows: LedgerRow[], s: WatchState | null, transfers: WatchTransfer[] = []) =>
    reconcileRows(rows, ACCOUNT, { state: s, transfers });

  it('concludes nothing from a watch that has said nothing', () => {
    const rows = [sent({ remove_at: NOW }), sent({ path: 'Seen', seen: true })];
    expect(settle(rows, null)).toBe(rows);
  });

  it('notes a book the watch lists, and stays the same array when nothing changes', () => {
    const [row] = settle([sent()], state({ books: [listed] }));
    expect(row.seen).toBe(true);
    const seen = [sent({ seen: true })];
    expect(settle(seen, state({ books: [listed] }))).toBe(seen);
  });

  it('keeps a row delivered and not yet listed', () => {
    const rows = [sent()];
    expect(settle(rows, state())).toBe(rows);
  });

  it('forgets a seen book once the watch stops listing it (removed by hand)', () => {
    expect(settle([sent({ seen: true })], state())).toEqual([]);
  });

  it('keeps a seen book sent again and still on its way', () => {
    const rows = [sent({ seen: true })];
    expect(settle(rows, state(), [transfer('book')])).toBe(rows);
  });

  it('keeps a removing row while the watch lists it', () => {
    const rows = [sent({ seen: true, remove_at: NOW })];
    expect(settle(rows, state({ books: [listed] }))).toBe(rows);
  });

  it('keeps a removing row while its message is on its way, listed or not', () => {
    const rows = [sent({ remove_at: NOW })];
    expect(settle(rows, state(), [transfer('remove')])).toBe(rows);
    expect(settle(rows, signedOut, [transfer('remove')])).toBe(rows);
  });

  it('is done when the watch drops it', () => {
    expect(settle([sent({ seen: true, remove_at: NOW })], state())).toEqual([]);
    // A row held and never listed: nothing left either.
    expect(settle([sent({ remove_at: NOW })], state())).toEqual([]);
  });

  it('calls a remove delivered to a watch signed out or on another account refused', () => {
    for (const s of [signedOut, otherAccount]) {
      const [row] = settle([sent({ remove_at: NOW })], s);
      expect(row.remove_refused).toBe(true);
      expect(row.remove_at).toBeUndefined();
    }
  });

  it('heals a refusal that was only the watch still signing in', () => {
    // The pair ahead of the remove finished, and the remove took the book.
    expect(settle([sent({ remove_refused: true })], state())).toEqual([]);
    // The watch signed in and took the book: it stands, with Remove offered again.
    const [row] = settle([sent({ remove_refused: true })], state({ books: [listed] }));
    expect(row.remove_refused).toBeUndefined();
    expect(row.seen).toBe(true);
  });

  it('forgets what the watch had of an account it has left', () => {
    expect(settle([sent({ seen: true })], signedOut)).toEqual([]);
    expect(settle([sent({ seen: true })], otherAccount)).toEqual([]);
    expect(settle([sent({ seen: true, remove_at: NOW })], signedOut)).toEqual([]);
  });

  it('keeps a row never seen when the watch is elsewhere: it may be held there', () => {
    const rows = [sent()];
    expect(settle(rows, signedOut)).toBe(rows);
    expect(settle(rows, otherAccount)).toBe(rows);
  });

  it('does not let another account’s word about the same book settle this one', () => {
    const rows = [sent({ seen: true, remove_at: NOW })];
    expect(
      reconcileRows(rows, ACCOUNT, {
        state: state({ books: [listed] }),
        transfers: [transfer('remove', { account: 'srv.8' })],
      }),
    ).toBe(rows);
    expect(
      reconcileRows([sent()], 'srv.8', { state: state({ books: [listed] }), transfers: [] })[0]
        .seen,
    ).toBeUndefined();
  });
});

describe('the rows as stored', () => {
  it('reads back what was kept', () => {
    const row = sent({ author: 'A', seen: true, remove_at: 5, remove_refused: true });
    expect(parseLedgerRow(JSON.parse(JSON.stringify(row)))).toEqual(row);
  });

  it('refuses what it cannot read, and takes a missing flag as false', () => {
    expect(parseLedgerRow(null)).toBeNull();
    expect(parseLedgerRow({ path: 'A/B' })).toBeNull();
    expect(parseLedgerRow({ library_id: 1, path: 2, title: 't', sent_at: 1 })).toBeNull();
    expect(parseLedgerRow({ library_id: 1, path: 'p', title: 't', sent_at: 1 })).toEqual({
      library_id: 1,
      path: 'p',
      title: 't',
      sent_at: 1,
      handed_over: false,
      send_cut_off: true,
    });
  });

  it('keeps one row per book', () => {
    const rows = putRow(putRow([], sent()), sent({ title: 'New' }));
    expect(rows.map((r) => r.title)).toEqual(['New']);
    expect(putRow(rows, sent({ path: 'C' }))).toHaveLength(2);
    expect(putRow(rows, sent({ library_id: 2 }))).toHaveLength(2);
    expect(dropRow(rows, { library_id: 1, path: 'A/B' })).toEqual([]);
    expect(dropRow(rows, { library_id: 2, path: 'A/B' })).toHaveLength(1);
  });
});
