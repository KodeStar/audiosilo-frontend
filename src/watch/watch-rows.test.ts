import { parseTransfers, type WatchState, type WatchTransfer } from './watch-model';
import {
  dropRow,
  type LedgerRow,
  parseLedgerRow,
  putRow,
  reconcileRows,
  removeAskedAt,
  rowActions,
  sameDetail,
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

describe('watchRows: how far a book on its way has come (fe#241)', () => {
  const one = (book: WatchState['books'][number], row?: LedgerRow) =>
    watchRows(
      row ? [row] : [],
      ACCOUNT,
      { state: state({ books: [book] }), transfers: [] },
      NOW,
    )[0];

  it('says how many files the server has ready while it prepares, and what it waits for', () => {
    const r = one({ ...listed, files_ready: 2, files_total: 5, waiting: 'server' });
    expect(r.phase).toBe('preparing');
    expect(r.detail).toEqual({ kind: 'files', ready: 2, total: 5 });
    expect(r.waiting).toBe('server');
  });

  it('says the percent while it downloads, not the files', () => {
    const r = one({
      ...listed,
      state: 'downloading',
      progress: 45,
      files_ready: 3,
      files_total: 10,
      waiting: 'connection',
    });
    expect(r.detail).toEqual({ kind: 'percent', percent: 45 });
    expect(r.waiting).toBe('connection');
  });

  it('says nothing more from a watch that tells none of it (older, or Wear OS)', () => {
    const preparing = one(listed);
    expect(preparing).not.toHaveProperty('detail');
    expect(preparing).not.toHaveProperty('waiting');
    expect(one({ ...listed, state: 'downloading' })).not.toHaveProperty('detail');
  });

  it('says nothing more once ready or failed, or while a Remove speaks for the row', () => {
    const extra = { progress: 45, files_ready: 1, files_total: 2, waiting: 'server' } as const;
    for (const s of ['ready', 'failed', 'queued'] as const) {
      const r = one({ ...listed, ...extra, state: s });
      expect([r.detail, r.waiting]).toEqual([undefined, undefined]);
    }
    const removing = one(
      { ...listed, ...extra, state: 'downloading' },
      sent({ remove_at: NOW - 1000, seen: true }),
    );
    expect(removing.phase).toBe('removing');
    expect([removing.detail, removing.waiting]).toEqual([undefined, undefined]);
  });

  it('tells one detail from another', () => {
    const files = { kind: 'files', ready: 1, total: 2 } as const;
    const pct = { kind: 'percent', percent: 45 } as const;
    expect(sameDetail(undefined, undefined)).toBe(true);
    expect(sameDetail(files, { ...files })).toBe(true);
    expect(sameDetail(pct, { ...pct })).toBe(true);
    expect(sameDetail(files, { ...files, ready: 2 })).toBe(false);
    expect(sameDetail(pct, { ...pct, percent: 50 })).toBe(false);
    expect(sameDetail(files, pct)).toBe(false);
    expect(sameDetail(pct, undefined)).toBe(false);
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
  it('offers Remove again once delivered: the watch may have lost it, and nothing else would move it', () => {
    expect(rowActions('removing')).toEqual({ remove: true, sendAgain: false, dismiss: false });
  });

  it('offers nothing while the remove is still on its way', () => {
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
    const failed = sent({
      send_failed: true,
      remove_failed: true,
      remove_at: 9,
      remove_asked_at: 5,
    });
    expect(parseLedgerRow(JSON.parse(JSON.stringify(failed)))).toEqual(failed);
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

describe('the ledger on Wear OS (nothing is ever failed)', () => {
  // The Android link lists the phone's own Data Layer items still held for the watch: present until
  // the watch app sends its receipt, never `failed` (an item waits for the watch for good).
  const wearHeld = (type: WatchTransfer['type']) =>
    parseTransfers([{ type, server_id: 'srv', user_id: 7, library_id: 1, path: 'A/B' }]);

  it('reads the held items as on their way, never as failed', () => {
    expect(wearHeld('book')).toEqual([transfer('book')]);
  });

  it('goes from sent to delivered to the watch’s own word, with no failure on the way', () => {
    const seen: string[] = [];
    let row = sent();
    const step = (s: WatchState, transfers: WatchTransfer[]) => {
      row = reconcileRows([row], ACCOUNT, { state: s, transfers })[0] ?? row;
      seen.push(phase(row, s, transfers));
    };
    step(state(), wearHeld('book'));
    step(state(), []);
    step(state({ books: [{ ...listed, state: 'queued' }] }), []);
    step(state({ books: [{ ...listed, state: 'ready' }] }), []);
    expect(seen).toEqual(['undelivered', 'delivered', 'queued', 'ready']);
  });

  it('removes in the same way, the row going once the watch lists the book no more', () => {
    const onWatch = state({ books: [{ ...listed, state: 'ready' }] });
    const row = sent({ seen: true, remove_at: NOW });
    expect(phase(row, onWatch, wearHeld('remove'))).toBe('removing-undelivered');
    expect(phase(row, onWatch, [])).toBe('removing');
    expect(reconcileRows([row], ACCOUNT, { state: state(), transfers: [] })).toEqual([]);
  });

  it('never says send-failed or remove-failed for a held item, however long it waits', () => {
    for (const t of [...wearHeld('book'), ...wearHeld('remove')]) {
      const row = t.type === 'remove' ? sent({ seen: true, remove_at: NOW }) : sent();
      const p = phase(row, state(), [t], NOW + 1000);
      expect(p).not.toBe('send-failed');
      expect(p).not.toBe('remove-failed');
    }
    // The hold limit is what ends a book the watch never takes.
    expect(phase(sent(), state(), wearHeld('book'), NOW + WATCH_HOLD_MS)).toBe('stale');
  });
});

describe('failed sends and removes kept on the row (fe#219)', () => {
  const settle = (rows: LedgerRow[], s: WatchState | null, transfers: WatchTransfer[] = []) =>
    reconcileRows(rows, ACCOUNT, { state: s, transfers });

  it('notes a failure the link reports, and still says it after a restart forgot it', () => {
    const [row] = settle([sent()], state(), [transfer('book', { failed: true })]);
    expect(row.send_failed).toBe(true);
    // The link's report is gone with the run: the row says it on its own.
    expect(phase(row, state())).toBe('send-failed');
    expect(settle([row], state())).toEqual([row]);
    expect(phase(row, signedOut)).toBe('send-failed');
  });

  it('keeps a seen book whose send again failed, rather than reading it as gone', () => {
    const [row] = settle([sent({ seen: true })], state(), [transfer('book', { failed: true })]);
    expect(settle([row], state())).toEqual([row]);
    expect(settle([row], signedOut)).toEqual([row]);
  });

  it('notes a failed remove, and does not read it as refused once the watch is elsewhere', () => {
    const on = state({ books: [listed] });
    const [row] = settle([sent({ seen: true, remove_at: NOW - 10 })], on, [
      transfer('remove', { failed: true }),
    ]);
    expect(row.remove_failed).toBe(true);
    expect(phase(row, on)).toBe('remove-failed');
    // A row the watch never listed (it may be held there for this account).
    const [elsewhere] = settle([{ ...row, seen: undefined }], otherAccount);
    expect(elsewhere.remove_refused).toBeUndefined();
    expect(phase(elsewhere, otherAccount)).toBe('remove-failed');
  });

  it('notes no failed remove on a row with no Remove of its own', () => {
    const rows = [sent({ seen: true })];
    expect(settle(rows, state({ books: [listed] }), [transfer('remove', { failed: true })])).toBe(
      rows,
    );
  });

  it('forgets a failed send once the book is on the watch', () => {
    const [row] = settle([sent({ send_failed: true })], state({ books: [listed] }));
    expect(row).toEqual(sent({ seen: true }));
  });
});

describe('a copy added since a Remove, and a Remove asked again (fe#219)', () => {
  const settle = (rows: LedgerRow[], s: WatchState | null, transfers: WatchTransfer[] = []) =>
    reconcileRows(rows, ACCOUNT, { state: s, transfers });
  const removing = sent({ seen: true, remove_at: NOW - 500 });

  it('drops the Remove when the listed copy was added after it was asked', () => {
    const back = state({ books: [{ ...listed, state: 'ready', added_at: NOW - 100 }] });
    const [row] = settle([removing], back);
    expect(row.remove_at).toBeUndefined();
    expect(phase(row, back)).toBe('ready');
  });

  it('keeps it for a copy from before, from the first Remove when it was asked again', () => {
    const before = state({ books: [{ ...listed, added_at: NOW - 600 }] });
    expect(settle([removing], before)).toEqual([removing]);
    // Asked again at NOW - 500 after a first Remove at NOW - 900: a copy added in between stays.
    const again = sent({ seen: true, remove_at: NOW - 500, remove_asked_at: NOW - 900 });
    const between = state({ books: [{ ...listed, added_at: NOW - 700 }] });
    expect(settle([again], between)[0].remove_at).toBeUndefined();
  });

  it('keeps it from a watch that does not say when (older, or Wear OS)', () => {
    expect(settle([removing], state({ books: [listed] }))).toEqual([removing]);
  });

  it('asks again with the first time while the Remove is under way, else now', () => {
    const copy = { ...listed, added_at: NOW - 5000 };
    expect(removeAskedAt(undefined, copy, NOW)).toBe(NOW);
    expect(removeAskedAt(sent(), copy, NOW)).toBe(NOW);
    expect(removeAskedAt(removing, copy, NOW)).toBe(NOW - 500);
    expect(removeAskedAt(removing, undefined, NOW)).toBe(NOW - 500);
    const again = sent({ remove_at: NOW - 500, remove_asked_at: NOW - 900 });
    expect(removeAskedAt(again, copy, NOW)).toBe(NOW - 900);
    // Past the hold limit the row is the watch's again: a Remove then is a new one.
    expect(removeAskedAt(sent({ remove_at: NOW - WATCH_HOLD_MS }), copy, NOW)).toBe(NOW);
  });

  it('asks again as a new Remove over a copy that does not say when it was added', () => {
    // A Wear OS watch: a copy back since the first Remove can't be told from the one it was for,
    // and the first one's time would never take it.
    expect(removeAskedAt(removing, listed, NOW)).toBe(NOW);
    const again = sent({ remove_at: NOW - 500, remove_asked_at: NOW - 900 });
    expect(removeAskedAt(again, listed, NOW)).toBe(NOW);
  });
});

describe('a book sent again while it was being removed (fe#219)', () => {
  const settle = (rows: LedgerRow[], s: WatchState | null, transfers: WatchTransfer[] = []) =>
    reconcileRows(rows, ACCOUNT, { state: s, transfers });
  // Sent again at NOW - 1000 (`sent`), the old copy still listed until the watch has removed it.
  const old = (added: number | undefined) =>
    state({ books: [{ ...listed, state: 'ready', ...(added ? { added_at: added } : {}) }] });

  it('says where the Send stands, not "on your watch", over a copy from before it', () => {
    expect(phase(sent({ handed_over: false }), old(NOW - 60_000))).toBe('undelivered');
    expect(phase(sent(), old(NOW - 60_000))).toBe('delivered');
    expect(phase(sent(), old(NOW - 60_000), [transfer('book')])).toBe('undelivered');
  });

  it('does not count that copy as the one sent', () => {
    const rows = [sent()];
    expect(settle(rows, old(NOW - 60_000))).toBe(rows);
  });

  it('takes the copy as the one sent within a second of the Send (the stamp round trip)', () => {
    expect(phase(sent(), old(NOW - 1000 - 1))).toBe('ready');
    expect(settle([sent()], old(NOW - 1000 - 1))[0].seen).toBe(true);
  });

  it('says where the Send stands while a remove is still on its way, from any watch', () => {
    expect(phase(sent(), old(undefined), [transfer('remove'), transfer('book')])).toBe(
      'undelivered',
    );
    // One that could not go removes nothing: the copy stays, and is the book's.
    expect(phase(sent(), old(undefined), [transfer('remove', { failed: true })])).toBe('ready');
  });

  it('shows the copy as it is once the watch has the book sent again', () => {
    expect(phase(sent(), old(NOW - 1000))).toBe('ready');
    expect(phase(sent(), old(NOW))).toBe('ready');
  });

  it('takes an older copy as the one sent on a row the watch has listed since that Send', () => {
    // A row from before 2.7.0: a Send for a book already on the watch, which that watch took for
    // the copy it had and no stamp moved on. It is on the watch, not "delivered" or stale.
    const seen = sent({ seen: true });
    expect(phase(seen, old(NOW - 60_000))).toBe('ready');
    expect(phase(seen, old(NOW - 60_000), [], NOW + WATCH_HOLD_MS)).toBe('ready');
    expect(settle([seen], old(NOW - 60_000))).toEqual([seen]);
  });
});
