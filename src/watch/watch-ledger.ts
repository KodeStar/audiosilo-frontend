import { create } from 'zustand';

import { parseConnectionId } from '@/lib/connection-id';
import { persistedDocument } from '@/lib/storage';
import { isRecord, WATCH_LEDGER_KEY } from '@/lib/storage-keys';
import { onConnectionRemoved } from '@/stores/session';

import type { WatchStatus } from './watch-model';
import {
  dropRow,
  type LedgerRow,
  parseLedgerRow,
  putRow,
  reconcileRows,
  sameBook,
} from './watch-rows';

/**
 * What this phone sent, by watch and then by account (`<server_id>.<user_id>`): a row belongs to
 * the one watch it went to (`WatchStatus.watchId`, which the system ties to that watch) and the one
 * account it names, so it can't show for another of either. One document in AsyncStorage, surviving
 * a cold start.
 */
type Ledger = Record<string, Record<string, LedgerRow[]>>;

type Book = { library_id: number; path: string; title: string; author?: string };

export const useWatchLedger = create<{ ledger: Ledger }>(() => ({ ledger: {} }));

function parseLedger(raw: unknown): Partial<Ledger> {
  if (!isRecord(raw)) return {};
  const ledger: Ledger = {};
  for (const [watchId, accounts] of Object.entries(raw)) {
    if (!isRecord(accounts)) continue;
    ledger[watchId] = {};
    for (const [account, rows] of Object.entries(accounts)) {
      if (!Array.isArray(rows)) continue;
      ledger[watchId][account] = rows.flatMap((r) => parseLedgerRow(r) ?? []);
    }
  }
  return ledger;
}

const stored = persistedDocument<Ledger>(WATCH_LEDGER_KEY, parseLedger);

/** Another watch's rows go once every one is this old: a watch unpaired or reset is never heard
 * from again, and its id names nothing. */
const DEAD_WATCH_MS = 90 * 24 * 60 * 60 * 1000;

/** Read what is kept. Once: later calls join the first. A write before it ends replaces the whole
 * watch's entry (`persistedDocument` lays early changes over the stored document by top-level key),
 * so whatever writes a row waits for it. */
export function hydrateLedger(): Promise<void> {
  return stored.hydrate(useWatchLedger.getState().ledger, (ledger) =>
    useWatchLedger.setState({ ledger }),
  );
}

function commit(watchId: string, accounts: Ledger[string]): void {
  const ledger = { ...useWatchLedger.getState().ledger, [watchId]: accounts };
  useWatchLedger.setState({ ledger });
  stored.write({ [watchId]: accounts }, ledger);
}

function changeRows(
  watchId: string,
  account: string,
  change: (rows: readonly LedgerRow[]) => readonly LedgerRow[],
): void {
  const accounts = useWatchLedger.getState().ledger[watchId] ?? {};
  const rows = accounts[account] ?? [];
  const next = change(rows);
  if (next === rows) return;
  const { [account]: _old, ...others } = accounts;
  commit(watchId, next.length > 0 ? { ...others, [account]: [...next] } : others);
}

/** The rows of one account on one watch, none where the watch can't be named. */
export function ledgerRows(ledger: Ledger, watchId: string | null, account: string): LedgerRow[] {
  return (watchId && ledger[watchId]?.[account]) || NO_ROWS;
}

const NO_ROWS: LedgerRow[] = [];

/** Send was tapped: the row appears now, not delivered until the link has it. Sent again, it starts
 * afresh. Returns what it replaced, for a send that fails. */
export function noteSending(
  watchId: string,
  account: string,
  book: Book,
  now: number,
): LedgerRow | undefined {
  const before = ledgerRows(useWatchLedger.getState().ledger, watchId, account).find((r) =>
    sameBook(r, book),
  );
  changeRows(watchId, account, (r) =>
    putRow(r, {
      library_id: book.library_id,
      path: book.path,
      title: book.title,
      ...(book.author ? { author: book.author } : {}),
      sent_at: now,
      handed_over: false,
    }),
  );
  return before;
}

/** The native link took the `book`: an earlier failure to deliver it is over. */
export function noteHandedOver(watchId: string, account: string, book: Book): void {
  changeRows(watchId, account, (rows) =>
    rows.map((r) => {
      if (!sameBook(r, book)) return r;
      const { send_failed: _failed, ...rest } = r;
      return { ...rest, handed_over: true };
    }),
  );
}

/** The send failed: back to what was there (`noteSending`'s answer), nothing if nothing was. */
export function restoreRow(
  watchId: string,
  account: string,
  book: Book,
  before: LedgerRow | undefined,
): void {
  changeRows(watchId, account, (rows) => (before ? putRow(rows, before) : dropRow(rows, book)));
}

/** A `remove` went, asked for at `askedAt` (`removeAskedAt`; earlier than `now` when it was asked
 * again): the row says so until the watch's word settles it. A book the phone never sent (the
 * watch's own Download button) gets its row here, already seen. */
export function noteRemoving(
  watchId: string,
  account: string,
  book: Book,
  now: number,
  askedAt: number = now,
): void {
  changeRows(watchId, account, (rows) => {
    const fresh: LedgerRow = {
      library_id: book.library_id,
      path: book.path,
      title: book.title,
      sent_at: now,
      handed_over: true,
      seen: true,
    };
    const before = rows.find((r) => sameBook(r, book));
    const {
      remove_refused: _refused,
      remove_failed: _failed,
      remove_asked_at: _asked,
      ...row
    } = before ?? fresh;
    return putRow(rows, {
      ...row,
      remove_at: now,
      ...(askedAt < now ? { remove_asked_at: askedAt } : {}),
    });
  });
}

/** The listener has read why a Remove was refused: the phone stops showing the row. */
export function forgetRow(watchId: string, account: string, book: Book): void {
  changeRows(watchId, account, (rows) => dropRow(rows, book));
}

/** When a row was last asked about (a Send or a Remove). */
const lastAsked = (row: LedgerRow) => Math.max(row.sent_at, row.remove_at ?? 0);

/** Take the watch's latest word. Only for the watch it is from: another's rows wait for that one,
 * unless every one of them is over 90 days old (`DEAD_WATCH_MS`). */
export function applyWatchStatus(
  status: Pick<WatchStatus, 'watchId' | 'state' | 'transfers'>,
  now: number = Date.now(),
) {
  const { watchId } = status;
  if (!watchId) return;
  for (const account of Object.keys(useWatchLedger.getState().ledger[watchId] ?? {})) {
    changeRows(watchId, account, (rows) => reconcileRows(rows, account, status));
  }
  const { ledger } = useWatchLedger.getState();
  const dead = (accounts: Ledger[string]) =>
    Object.values(accounts).every((rows) => rows.every((r) => now - lastAsked(r) > DEAD_WATCH_MS));
  const entries = Object.entries(ledger);
  const live = entries.filter(([id, accounts]) => id === watchId || !dead(accounts));
  if (live.length === entries.length) return;
  const kept = Object.fromEntries(live);
  useWatchLedger.setState({ ledger: kept });
  stored.write({}, kept);
}

/** A removed account's rows go with it. A legacy connection id names only a server: every account
 * of that one. */
export function followConnectionRemovals(): void {
  onConnectionRemoved(async (id) => {
    // What is kept first, or its rows come back with it.
    await hydrateLedger();
    const gone = parseConnectionId(id);
    const isGone = (account: string) => {
      const named = parseConnectionId(account);
      return (
        named.serverId === gone.serverId &&
        (gone.userId === undefined || named.userId === gone.userId)
      );
    };
    for (const [watchId, accounts] of Object.entries(useWatchLedger.getState().ledger)) {
      for (const account of Object.keys(accounts).filter(isGone)) {
        changeRows(watchId, account, () => []);
      }
    }
  });
}
