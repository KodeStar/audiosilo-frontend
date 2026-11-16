import { isRecord } from '@/lib/storage-keys';

import {
  accountOnWatch,
  type WatchBook,
  type WatchStatus,
  type WatchTransfer,
  type WatchWait,
} from './watch-model';

/**
 * What the phone sent its watch and what it shows for it, pure: the rules of the Downloads page's
 * "On your watch" section (Apple Watch and Wear OS). `watch-ledger.ts` keeps the rows; the watch only ever says what it
 * holds now (`watch-state`), so the ledger is what lets a row appear the moment Send is tapped,
 * tell "not delivered" from "delivered", and go on saying "removing" after the phone restarts.
 */

/** A sent row the watch never lists stops claiming progress after this, and a Remove stops saying
 * "removing": the watch's own hold limit (`HeldBooks.MAX_AGE`). */
export const WATCH_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** How much older than the last Send a listed copy must be to be another copy: the watch keeps the
 * phone's `asked_at` as a `Date` and writes it back, which can lose a millisecond. A copy that
 * really is older came from a tap seconds or days before. */
const STAMP_SLACK_MS = 1000;

/** One book the phone asked this watch about, for one account. No DB id: `(library_id, path)`. */
export type LedgerRow = {
  library_id: number;
  path: string;
  title: string;
  author?: string;
  /** Epoch ms of the last Send. */
  sent_at: number;
  /** The native link took the `book`. False while a pair is minted and sent ahead of it, and if the
   * app died meanwhile: the row can't say it was delivered. */
  handed_over: boolean;
  /** Read at launch not handed over: the app died sending it and nothing carries that on, so it is
   * not on its way, whatever it says. Sent again, it starts afresh. */
  send_cut_off?: boolean;
  /** The watch has listed it since it was sent: its going from the list means it went. */
  seen?: boolean;
  /** Epoch ms of the last Remove, while no answer has come. */
  remove_at?: number;
  /** Epoch ms of the first Remove, when it was asked again: the repeat carries it as `asked_at`, so
   * a copy the watch added since stays (fe#219). */
  remove_asked_at?: number;
  /** The watch was on another account or signed out when the `remove` reached it. */
  remove_refused?: boolean;
  /** The system could not deliver the last `book` (`remove`). The link says so only for the run
   * that heard it, so the row keeps it, or after a restart it would read as delivered. Cleared by
   * the next send (Remove). */
  send_failed?: boolean;
  remove_failed?: boolean;
};

type BookId = { library_id: number; path: string };

export const sameBook = (a: BookId, b: BookId) =>
  a.library_id === b.library_id && a.path === b.path;

/** A stored row, null if it can't be read. */
export function parseLedgerRow(raw: unknown): LedgerRow | null {
  if (
    !isRecord(raw) ||
    typeof raw.library_id !== 'number' ||
    typeof raw.path !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.sent_at !== 'number'
  ) {
    return null;
  }
  return {
    library_id: raw.library_id,
    path: raw.path,
    title: raw.title,
    ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
    sent_at: raw.sent_at,
    handed_over: raw.handed_over === true,
    ...(raw.handed_over !== true ? { send_cut_off: true } : {}),
    ...(raw.seen === true ? { seen: true } : {}),
    ...(typeof raw.remove_at === 'number' ? { remove_at: raw.remove_at } : {}),
    ...(typeof raw.remove_asked_at === 'number' ? { remove_asked_at: raw.remove_asked_at } : {}),
    ...(raw.remove_refused === true ? { remove_refused: true } : {}),
    ...(raw.send_failed === true ? { send_failed: true } : {}),
    ...(raw.remove_failed === true ? { remove_failed: true } : {}),
  };
}

/** Whether the row's Remove is still under way (no answer, within the hold limit). */
const removing = (row: LedgerRow, now: number) =>
  row.remove_at !== undefined && now - row.remove_at < WATCH_HOLD_MS;

/** When the row's Remove was first asked (`remove_asked_at` is kept only for one asked again). */
const firstRemoveAt = (row: LedgerRow) => row.remove_asked_at ?? row.remove_at;

/** What a Remove tapped now carries as `asked_at`: the first one's time while that one is under
 * way, so asking again never takes a copy the watch added since; else now. Now too over a listed
 * `copy` that does not say when it was added (a Wear OS watch): the phone can't learn that one came
 * back (`addedSinceRemove`), the row would go on saying "removing", and the first one's time would
 * never take it. */
export function removeAskedAt(
  row: LedgerRow | undefined,
  copy: WatchBook | undefined,
  now: number,
): number {
  if (!row || !removing(row, now)) return now;
  if (copy && copy.added_at === undefined) return now;
  return firstRemoveAt(row) ?? now;
}

/** A listed copy added before the row's last Send: an earlier one, not the copy sent. Only from a
 * watch that says when (`added_at`), and not for a row whose Remove speaks for it, nor one the
 * watch has listed since that Send: a row is seen only once its copy counts as the one sent, so a
 * seen row's older copy is one an earlier watch or phone took as that Send's (a Send for a book
 * already there, before either stamped `asked_at`), which no later word re-stamps. */
function olderThanSend(copy: WatchBook, row: LedgerRow): boolean {
  return (
    !row.seen &&
    row.remove_at === undefined &&
    copy.added_at !== undefined &&
    copy.added_at < row.sent_at - STAMP_SLACK_MS
  );
}

/** A listed copy the row's last Send has yet to replace, or with a `remove` on its way since: the
 * row says where it stands. */
function aboutToGo(
  copy: WatchBook,
  row: LedgerRow,
  account: string,
  transfers: readonly WatchTransfer[],
): boolean {
  return (
    olderThanSend(copy, row) ||
    (row.remove_at === undefined && transferOf(transfers, 'remove', account, row)?.failed === false)
  );
}

/** A copy added after the row's Remove was asked, which the watch keeps (`asked_at`): that Remove
 * is over. */
function addedSinceRemove(copy: WatchBook, row: LedgerRow): boolean {
  const asked = firstRemoveAt(row);
  return asked !== undefined && copy.added_at !== undefined && copy.added_at > asked;
}

/** The rows with `row` in the place of the same book's. */
export function putRow(rows: readonly LedgerRow[], row: LedgerRow): LedgerRow[] {
  const at = rows.findIndex((r) => sameBook(r, row));
  if (at < 0) return [...rows, row];
  return rows.map((r, i) => (i === at ? row : r));
}

/** The rows without this book. */
export function dropRow(rows: readonly LedgerRow[], book: BookId): LedgerRow[] {
  return rows.filter((r) => !sameBook(r, book));
}

function transferOf(
  transfers: readonly WatchTransfer[],
  type: WatchTransfer['type'],
  account: string,
  book: BookId,
): WatchTransfer | undefined {
  return transfers.find((t) => t.type === type && t.account === account && sameBook(t, book));
}

/**
 * What the latest word from the watch settles for `account`'s rows on this watch. `watch-state`
 * names only the account it is signed in to, so it says nothing of a book of any other but this:
 * the watch took that account's books with it when it left, and it refuses a `remove` for it.
 * The same array when nothing changed.
 */
export function reconcileRows(
  rows: readonly LedgerRow[],
  account: string,
  status: Pick<WatchStatus, 'state' | 'transfers'>,
): readonly LedgerRow[] {
  // Never told anything: nothing can be concluded.
  if (!status.state) return rows;
  const here = accountOnWatch(status.state) === account;
  const listed = here ? status.state.books : [];
  const out: LedgerRow[] = [];
  let changed = false;
  for (const row of rows) {
    const next = settleRow(row, account, listed, here, status.transfers);
    if (next !== row) changed = true;
    if (next) out.push(next);
  }
  return changed ? out : rows;
}

function settleRow(
  given: LedgerRow,
  account: string,
  listed: readonly WatchBook[],
  here: boolean,
  transfers: readonly WatchTransfer[],
): LedgerRow | null {
  let row = given;
  const removeSent = transferOf(transfers, 'remove', account, row);
  const bookSent = transferOf(transfers, 'book', account, row);
  // A failure the link tells only this run: kept on the row.
  if (bookSent?.failed && !row.send_failed) row = { ...row, send_failed: true };
  if (removeSent?.failed && row.remove_at !== undefined && !row.remove_failed) {
    row = { ...row, remove_failed: true };
  }
  const copy = listed.find((b) => sameBook(b, row));
  if (copy) {
    if (addedSinceRemove(copy, row)) {
      const { remove_at: _at, remove_asked_at: _asked, remove_failed: _failed, ...rest } = row;
      row = rest;
    }
    // An earlier copy than the one sent last: that one has yet to be seen.
    if (olderThanSend(copy, row)) return row;
    // On the watch: seen, and any refusal or failed send is over (it signed in, and the book came
    // after all).
    if (row.seen && !row.remove_refused && !row.send_failed) return row;
    const { remove_refused: _refused, send_failed: _failed, ...rest } = row;
    return { ...rest, seen: true };
  }
  if (here) {
    // Not on the watch. A `remove` still on its way has its turn yet; otherwise it has gone, by
    // this `remove` or by hand. A book sent again and on its way, or that could not go, is another
    // matter.
    if (row.remove_at !== undefined || row.remove_refused) return removeSent ? row : null;
    return row.seen && !bookSent && !row.send_failed ? null : row;
  }
  // The watch is signed out or on another account: what it had of this one went with it. A
  // `remove` that never got there was not refused.
  if (row.seen && !bookSent && !row.send_failed) return null;
  if (row.remove_at !== undefined && !removeSent && !row.remove_failed) {
    const { remove_at: _at, remove_asked_at: _asked, ...rest } = row;
    return { ...rest, remove_refused: true };
  }
  return row;
}

export type WatchRowPhase =
  /** The `book` has not reached the watch yet. */
  | 'undelivered'
  /** Delivered; the watch app has to open to take it. */
  | 'delivered'
  /** Delivered; the watch has to sign in to this account. */
  | 'waiting-sign-in'
  /** The system could not deliver it. */
  | 'send-failed'
  /** 7 days with the watch never listing it. */
  | 'stale'
  | WatchBook['state']
  /** The `remove` has not reached the watch yet. */
  | 'removing-undelivered'
  /** Delivered; the watch app has to open to carry it out. */
  | 'removing'
  /** The system could not deliver it. */
  | 'remove-failed'
  /** The watch is on another account or signed out, so it did not. */
  | 'remove-refused';

/** What a row on its way says beyond its phase (fe#241), when the watch told it. */
export type WatchRowDetail =
  /** Preparing on the server: how many of its files are ready there. */
  | { kind: 'files'; ready: number; total: number }
  /** Downloading: the share of its audio on the watch. */
  | { kind: 'percent'; percent: number };

export type WatchRow = {
  library_id: number;
  path: string;
  title: string;
  author?: string;
  bytes?: number;
  phase: WatchRowPhase;
  detail?: WatchRowDetail;
  /** Preparing or downloading, and held up: by what. */
  waiting?: WatchWait;
};

/** A listed book's detail and wait for the phase its row shows. Nothing for a row that says
 * something else (a Remove on its way), or from a watch that tells none of it. */
function howFar(book: WatchBook, phase: WatchRowPhase): Pick<WatchRow, 'detail' | 'waiting'> {
  if (phase !== 'preparing' && phase !== 'downloading') return {};
  let detail: WatchRowDetail | undefined;
  if (phase === 'downloading') {
    if (book.progress !== undefined) detail = { kind: 'percent', percent: book.progress };
  } else if (book.files_total !== undefined) {
    detail = { kind: 'files', ready: book.files_ready ?? 0, total: book.files_total };
  }
  return {
    ...(detail ? { detail } : {}),
    ...(book.waiting ? { waiting: book.waiting } : {}),
  };
}

/** Whether two rows' details say the same (the section's memo). */
export function sameDetail(a: WatchRowDetail | undefined, b: WatchRowDetail | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'percent') return b.kind === 'percent' && a.percent === b.percent;
  return b.kind === 'files' && a.ready === b.ready && a.total === b.total;
}

/**
 * The row's actions. A `remove` still with the system has none: it is on its way, and it says so.
 * Delivered, it can offer Remove again: a watch before 2.7.0 kept what it had yet to handle only in
 * memory, so a kill lost it, and the row would otherwise sit with no way out until the hold limit.
 */
export function rowActions(phase: WatchRowPhase): {
  remove: boolean;
  sendAgain: boolean;
  dismiss: boolean;
} {
  const refused = phase === 'remove-refused';
  return {
    remove: phase !== 'removing-undelivered' && !refused,
    sendAgain: phase === 'stale' || phase === 'send-failed' || phase === 'failed',
    dismiss: refused,
  };
}

function removePhase(
  row: LedgerRow | undefined,
  account: string,
  transfers: readonly WatchTransfer[],
  now: number,
): WatchRowPhase | null {
  if (!row) return null;
  if (row.remove_refused) return 'remove-refused';
  if (!removing(row, now)) return null;
  const sent = transferOf(transfers, 'remove', account, row);
  if (sent?.failed || row.remove_failed) return 'remove-failed';
  return sent ? 'removing-undelivered' : 'removing';
}

/** Where a row the watch does not list stands. */
function unlistedPhase(
  row: LedgerRow,
  account: string,
  status: Pick<WatchStatus, 'state' | 'transfers'>,
  now: number,
): WatchRowPhase {
  const sent = transferOf(status.transfers, 'book', account, row);
  if (sent?.failed || row.send_failed) return 'send-failed';
  if (now - row.sent_at >= WATCH_HOLD_MS) return 'stale';
  if (sent) return 'undelivered';
  if (!row.handed_over) return row.send_cut_off ? 'send-failed' : 'undelivered';
  // Signed out or on another account, it is held there until this account signs in; never told
  // anything, the app has yet to open at all.
  return status.state && accountOnWatch(status.state) !== account ? 'waiting-sign-in' : 'delivered';
}

/**
 * The section's rows for `account` on this watch: what the watch lists (which wins over the
 * ledger, and shows only under the account it names), then what was sent and is not listed. Books
 * the phone never sent, from the watch's own Download button, are listed too. A listed copy from
 * before the row's last Send, or with a `remove` still on its way since, is about to go: the row
 * says where the Send stands (a book sent again while it was being removed, fe#219).
 */
export function watchRows(
  rows: readonly LedgerRow[],
  account: string,
  status: Pick<WatchStatus, 'state' | 'transfers'>,
  now: number,
): WatchRow[] {
  const here = accountOnWatch(status.state) === account;
  const listed = here ? (status.state?.books ?? []) : [];
  const out: WatchRow[] = listed.map((book) => {
    const row = rows.find((r) => sameBook(r, book));
    const phase =
      removePhase(row, account, status.transfers, now) ??
      (row && aboutToGo(book, row, account, status.transfers)
        ? unlistedPhase(row, account, status, now)
        : book.state);
    return {
      library_id: book.library_id,
      path: book.path,
      title: book.title,
      author: row?.author,
      bytes: book.bytes,
      phase,
      ...howFar(book, phase),
    };
  });
  for (const row of rows) {
    if (listed.some((b) => sameBook(b, row))) continue;
    out.push({
      library_id: row.library_id,
      path: row.path,
      title: row.title,
      author: row.author,
      phase:
        removePhase(row, account, status.transfers, now) ??
        unlistedPhase(row, account, status, now),
    });
  }
  return out;
}
