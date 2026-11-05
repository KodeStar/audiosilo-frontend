import { isRecord } from '@/lib/storage-keys';

import {
  accountOnWatch,
  type WatchBook,
  type WatchStatus,
  type WatchTransfer,
} from './watch-model';

/**
 * What the phone sent its watch and what it shows for it, pure: the rules of the Downloads page's
 * "On your Apple Watch" section. `watch-ledger.ts` keeps the rows; the watch only ever says what it
 * holds now (`watch-state`), so the ledger is what lets a row appear the moment Send is tapped,
 * tell "not delivered" from "delivered", and go on saying "removing" after the phone restarts.
 */

/** A sent row the watch never lists stops claiming progress after this, and a Remove stops saying
 * "removing": the watch's own hold limit (`HeldBooks.MAX_AGE`). */
export const WATCH_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** The watch was on another account or signed out when the `remove` reached it. */
  remove_refused?: boolean;
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
    ...(raw.remove_refused === true ? { remove_refused: true } : {}),
  };
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
  row: LedgerRow,
  account: string,
  listed: readonly WatchBook[],
  here: boolean,
  transfers: readonly WatchTransfer[],
): LedgerRow | null {
  const removeSent = transferOf(transfers, 'remove', account, row);
  const bookSent = transferOf(transfers, 'book', account, row);
  if (listed.some((b) => sameBook(b, row))) {
    // On the watch: seen, and any refusal is over (it signed in, and the book came after all).
    if (row.seen && !row.remove_refused) return row;
    const { remove_refused: _refused, ...rest } = row;
    return { ...rest, seen: true };
  }
  if (here) {
    // Not on the watch. A `remove` still on its way has its turn yet; otherwise it has gone, by
    // this `remove` or by hand. A book sent again and on its way is another matter.
    if (row.remove_at !== undefined || row.remove_refused) return removeSent ? row : null;
    return row.seen && !bookSent ? null : row;
  }
  // The watch is signed out or on another account: what it had of this one went with it.
  if (row.seen && !bookSent) return null;
  if (row.remove_at !== undefined && !removeSent) {
    const { remove_at: _at, ...rest } = row;
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

export type WatchRow = {
  library_id: number;
  path: string;
  title: string;
  author?: string;
  bytes?: number;
  phase: WatchRowPhase;
};

/**
 * The row's actions. A `remove` still with the system has none: it is on its way, and it says so.
 * Delivered, it can offer Remove again: the watch keeps what it has yet to handle only in memory, so
 * a kill loses it, and the row would otherwise sit with no way out until the hold limit.
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
  if (row.remove_at === undefined || now - row.remove_at >= WATCH_HOLD_MS) return null;
  const sent = transferOf(transfers, 'remove', account, row);
  if (sent?.failed) return 'remove-failed';
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
  if (sent?.failed) return 'send-failed';
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
 * the phone never sent, from the watch's own Download button, are listed too.
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
    return {
      library_id: book.library_id,
      path: book.path,
      title: book.title,
      author: row?.author,
      bytes: book.bytes,
      phase: removePhase(row, account, status.transfers, now) ?? book.state,
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
