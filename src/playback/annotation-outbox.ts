import {
  type ApiClient,
  ApiError,
  isRefusedForGood,
  isServerAwayError,
  isServerBusyError,
  isSignedOutError,
  isUnreachableError,
} from '@/api/client';
import {
  connectionOf,
  resolveClient,
  sessionReady,
  whenSessionReady,
} from '@/api/connection-clients';
import { addBookmark, cachedCapability, fetchCapabilities, showServerBookmark } from '@/api/hooks';
import { isReachable, noteFailure, onReconnect } from '@/api/reachability';
import type { Bookmark, BookmarkLabel } from '@/api/types';
import { contentKey, contentKeyOf } from '@/lib/content-key';
import { type Claimed, replayQueue, type Route, unclaimed } from '@/lib/queue-claims';
import { randomUUID } from '@/lib/random';
import { sharedStart } from '@/lib/shared-start';
import { serialQueue } from '@/lib/serial-queue';
import { getItemStrict, setItemStrict } from '@/lib/storage';
import { ANNOTATION_OUTBOX_KEY as KEY, isRecord } from '@/lib/storage-keys';
import { onStoredChange } from '@/lib/tab-channel';
import { tabLock } from '@/lib/tab-lock';
import { onConnectionRemoved, useSession } from '@/stores/session';

import { connectionGeneration } from './listening-outbox';
import { onlyConnection, queuedRoute } from './progress-sync';

/**
 * The bookmark outbox (fe#356): a bookmark made while its server can't take it (no answer, a
 * busy or failing server, a token it refuses until the connection signs in again) waits here
 * on the device and is sent once the server is back, instead of being refused. The ways in:
 * `addBookmarkOrQueue` tries the server first and keeps the bookmark only when that can't
 * work now; `queueBookmark` (a delete's Undo) and `queueNewBookmark` (the sleep timer's)
 * always store it first and leave the send to a replay. The same
 * guarantees as the listening outbox (`listening-outbox.ts`), on the simpler shape a bookmark
 * needs:
 *
 * - Per connection: every entry carries its `connectionId` and goes through that
 *   connection's own client.
 * - Persisted: `audiosilo.annotationOutbox`, shared by the web player's tabs (its
 *   read-modify-writes take `tabLock`, and a tab follows another's change through `storage`
 *   events). A write storage refuses throws: the caller then says the bookmark failed, as
 *   before, rather than holding one that a reload would lose.
 * - Ordered within a book: oldest first. A new bookmark goes behind any of its book still
 *   waiting, and a replay that can't send one yet holds back the rest of its book (not one
 *   waiting only for its server's flags: see the end). Other books' bookmarks go past it
 *   (their order does not matter): one that keeps failing never holds up the connection's
 *   queue. A replay stops only at a failure that is the connection's (`connectionFailure`).
 * - Not for ever: one still failing `GIVE_UP_MS` after it first failed against a server that
 *   answered, and after `GIVE_UP_TRIES` such failures, is dropped, logged (`givenUp`). Never
 *   on its first failures, and a server that is away, busy or waiting for a sign-in does not
 *   count. A labelled one held because its server's flags can't be read counts too.
 * - Retried: at launch, on the server's reconnect and once a connection a 401 flagged is
 *   signed in again (`startBookmarkSync`), with the stored queues in the foreground and on the
 *   web's focus and `online` (`startQueueReplays`), and with a backoff while a reachable
 *   server still has some waiting (`scheduleRetry`). A replay claims what it sends (`replayQueue`,
 *   `src/lib/queue-claims.ts`), so two tabs never send the same bookmark at once; one taken
 *   out while a replay sends those ahead of it is not sent (`readyToSend`).
 * - Sent once: the server's bookmark POST has no idempotency key, and a request that got no
 *   answer may still have landed (or a tab may have died mid-send). So a replay reads the
 *   book's bookmarks first and takes one already there at the same second with the same note
 *   as this bookmark, sent: one it did not see before its first send of it (`othersHeld`),
 *   else, for one a send may have reached before it was stored (a direct add whose answer was
 *   lost, an Undo), one made no earlier than a day before it. A bookmark no send has reached
 *   (`fresh`: the sleep timer's, one kept without trying the server) is never taken for an
 *   earlier one at its place, such as the night before's.
 * - Dropped on sign-out and when a connection is removed (`onConnectionRemoved`), like the
 *   listening outbox, after a last send while the token still works
 *   (`sendBookmarksBeforeRemoval`, in `flushConnectionSaves`): signing in again starts from
 *   the server's record. One made before the removal and appended after it is not appended
 *   (`since`). An entry whose connection is gone once the session has loaded (a storage
 *   reset) is dropped by the next replay (`queuedRoute`: not while an identity move is on its
 *   way).
 *
 * A bookmark the server refuses for good (its POST answered with a 4xx other than 401, 408
 * and 429: the book is gone or out of the account's reach) is dropped, logged. The read
 * before the send drops nothing: when it fails, whatever the status, the bookmark waits.
 * Labels follow `postBookmark`'s rule at send time (`addBookmark`), on flags that are known: a
 * labelled bookmark is sent only once its server's `/server` has been read (`readLabelFlag`),
 * and waits while it can't be, so the label is never dropped just because that read failed.
 * What it waits for is the flags, not its turn: the book's unlabelled ones behind it go past
 * it, and the wait counts toward giving up on it.
 */

/** A bookmark waiting for its server. */
export type QueuedBookmark = {
  /** This device's id for it (never the server's). */
  id: string;
  connectionId: string;
  libraryId: number;
  path: string;
  /** Whole-book seconds, as the server takes them. */
  position: number;
  note: string;
  label?: BookmarkLabel;
  /** When it was made (ISO, this device's clock), unique among the book's entries: the
   * replay's key for it (`queuedKey`). */
  updated_at: string;
  /** When a send of it first failed against a server that answered (ISO, this device's
   * clock), and how many have failed so: the outbox gives up on it past `GIVE_UP_MS` and
   * `GIVE_UP_TRIES` (`givenUp`). Absent until its first such failure. */
  failedSince?: string;
  failures?: number;
  /** Made here and not sent yet by anything (no add tried first, no Undo of one a replay may
   * have sent): no bookmark on its server can be this one, however near. Cleared, with
   * `othersHeld` set, by the replay's first send of it. */
  fresh?: true;
  /** The ids of the bookmarks at its place (the same second, the same note) its server held
   * before its first send: never this one. Any other one there is it (`isThisOne`). */
  othersHeld?: number[];
};

/** What `addBookmarkOrQueue` did: made on the server, or kept here to send later. */
type AddBookmarkOutcome = { made: Bookmark } | { queued: QueuedBookmark };

/** A bookmark on the server counts as a queued one sent earlier when it was made no earlier
 * than this before it (the server's clock may be a little behind the device's): for one
 * neither `fresh` nor with `othersHeld` (`isThisOne`). */
const SAME_BOOKMARK_WINDOW_MS = 24 * 60 * 60_000;
/** How long a bookmark may keep failing against a server that answers before the outbox
 * gives up on it (`givenUp`)... */
const GIVE_UP_MS = 7 * 24 * 60 * 60_000;
/** ...and how many failed sends at least: two a week apart, with no try between them (the
 * app closed, the server away), are not a week of failing. */
const GIVE_UP_TRIES = 10;
/** The backoff while a server answers but fails (a 5xx, a 429): from this... */
const RETRY_MIN_MS = 30_000;
/** ...doubling up to this. */
const RETRY_MAX_MS = 10 * 60_000;

// --- The stored queue ---------------------------------------------------------------------

const isQueued = (v: unknown): v is Claimed<QueuedBookmark> =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  typeof v.connectionId === 'string' &&
  typeof v.libraryId === 'number' &&
  typeof v.path === 'string' &&
  typeof v.position === 'number' &&
  typeof v.note === 'string' &&
  typeof v.updated_at === 'string' &&
  (v.label === undefined || typeof v.label === 'string') &&
  (v.failedSince === undefined || typeof v.failedSince === 'string') &&
  (v.failures === undefined || typeof v.failures === 'number') &&
  (v.fresh === undefined || v.fresh === true) &&
  (v.othersHeld === undefined ||
    (Array.isArray(v.othersHeld) && v.othersHeld.every((id) => typeof id === 'number')));

const entriesOf = (raw: unknown): Claimed<QueuedBookmark>[] =>
  Array.isArray(raw) ? raw.filter(isQueued) : [];

/** The stored queue's read-modify-writes, in this tab and across tabs. */
const withLock = tabLock(KEY);

/** The stored queue (rejects when storage can't be read). */
async function readQueue(): Promise<Claimed<QueuedBookmark>[]> {
  const queue = entriesOf(await getItemStrict<unknown>(KEY));
  setSnapshot(queue);
  return queue;
}

/** Store the queue (rejects when storage refused it). */
async function writeQueue(next: Claimed<QueuedBookmark>[]): Promise<void> {
  await setItemStrict(KEY, next);
  setSnapshot(next);
}

// --- What the screens read ----------------------------------------------------------------

/** The queue as last read or written here (or by another tab), without the claims. */
let snapshot: readonly QueuedBookmark[] = [];
let snapshotRead = false;
const listeners = new Set<() => void>();

/** Whether the screens would read the same from both: the same entries in the same order,
 * each for the same connection (an identity move rewrites the ids in place) and, for
 * `heldOnServer`, the same since its first send. */
const sameEntries = (a: readonly QueuedBookmark[], b: readonly QueuedBookmark[]) =>
  a.length === b.length &&
  a.every(
    (e, i) => e.id === b[i].id && e.connectionId === b[i].connectionId && e.fresh === b[i].fresh,
  );

function setSnapshot(queue: Claimed<QueuedBookmark>[]): void {
  snapshotRead = true;
  const next = queue.map((e) => unclaimed(e));
  if (sameEntries(snapshot, next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

// The web: another tab changed the stored queue.
onStoredChange(KEY, (raw) => {
  try {
    setSnapshot(raw ? entriesOf(JSON.parse(raw)) : []);
  } catch {
    // not JSON: the next read says what is there
  }
});

/** Every bookmark waiting, oldest first, as last read (`loadQueuedBookmarks`). The same
 * array until the queue changes (a `useSyncExternalStore` snapshot). */
export function queuedBookmarksSnapshot(): readonly QueuedBookmark[] {
  return snapshot;
}

/** Be told when the waiting bookmarks change; returns the unsubscribe. */
export function onQueuedBookmarksChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let firstLoad: Promise<void> | null = null;

/** Read the stored queue once, for the first screen that shows it. */
export function loadQueuedBookmarks(): Promise<void> {
  if (snapshotRead) return Promise.resolve();
  firstLoad ??= readQueue().then(
    () => undefined,
    () => {
      firstLoad = null; // unreadable: the next screen asks again
    },
  );
  return firstLoad;
}

/** The bookmarks waiting for `connectionId`'s server, oldest first (all when absent). */
export async function queuedBookmarks(connectionId?: string): Promise<QueuedBookmark[]> {
  const queue = (await readQueue()).map((e) => unclaimed(e));
  return connectionId === undefined ? queue : queue.filter((e) => e.connectionId === connectionId);
}

// --- Adding -------------------------------------------------------------------------------

type NewEntry = Omit<
  QueuedBookmark,
  'id' | 'updated_at' | 'failedSince' | 'failures' | 'fresh' | 'othersHeld'
>;

/** Append a bookmark behind every other one waiting (`fresh`: no send of it has gone out).
 * Rejects when its connection was removed since `since` (its sign-in, `connectionGeneration`),
 * or when storage refused the write. */
function append(fields: NewEntry, since: number, fresh: boolean): Promise<QueuedBookmark> {
  return withLock(async () => {
    if (connectionGeneration(fields.connectionId) !== since) throw new Error('connection gone');
    const queue = await readQueue();
    // Unique per book: the replay settles an entry by its book and this time.
    const book = contentKeyOf(fields);
    const taken = new Set(queue.filter((e) => contentKeyOf(e) === book).map((e) => e.updated_at));
    let at = Date.now();
    while (taken.has(new Date(at).toISOString())) at++;
    const entry: QueuedBookmark = {
      ...fields,
      id: randomUUID(),
      updated_at: new Date(at).toISOString(),
      ...(fresh ? { fresh: true as const } : {}),
    };
    await writeQueue([...queue, entry]);
    return entry;
  });
}

/** A server's refusal of a bookmark for good: a 4xx other than 401 (a token it refuses until
 * the connection signs in again), 408 and 429. */
const refusedForGood = (err: unknown) => isRefusedForGood(err) && !isSignedOutError(err);

/** Whether a failed add is worth keeping to send later: no answer, a server failing or
 * asking for a moment (5xx, 408, 429), or a 401. Not a refusal for good, nor a code bug. */
const worthKeeping = (err: unknown) =>
  isUnreachableError(err) || (err instanceof ApiError && !refusedForGood(err));

/** Read `connectionId`'s flags when whether its server takes a bookmark's label
 * (`annotations`) is not known yet. Resolves to nothing once it is known, else to the read's
 * failure: a queued bookmark then waits with its label, rather than going without it
 * (`postBookmark` drops a label on flags not known). */
async function readLabelFlag(
  connectionId: string,
  client: ApiClient,
): Promise<{ failed: unknown } | undefined> {
  if (cachedCapability(connectionId, 'annotations') !== undefined) return undefined;
  return fetchCapabilities(connectionId, client).then(
    () => undefined,
    (failed: unknown) => ({ failed }),
  );
}

/**
 * Add a bookmark to a book on ONE connection's server, or keep it on the device when the
 * server can't take it now (see the module). Straight to the server when none of its book
 * is waiting and the server reads as reachable (`addBookmark`, which refreshes the book's lists);
 * otherwise, or when that fails with a failure worth another try, it goes into the outbox.
 * Unlabelled: a labelled one goes through `queueNewBookmark` or `queueBookmark`, whose replay
 * sends it once its server's flags are known. Rejects when the connection is gone, the server
 * refused it for good, or the device could not store it.
 */
export async function addBookmarkOrQueue(
  connectionId: string,
  libraryId: number,
  path: string,
  position: number,
  note = '',
): Promise<AddBookmarkOutcome> {
  if (!resolveClient(connectionId)) throw new Error('connection gone');
  const since = connectionGeneration(connectionId);
  // Behind any of its book still waiting: they reach the server in the order they were made
  // (another book's say nothing about this one). The copy here once read (another tab's
  // changes reach it through `storage` events).
  const queue = snapshotRead ? snapshot : await readQueue().catch(() => snapshot);
  const book = contentKey(connectionId, libraryId, path);
  const waiting = queue.some((e) => contentKeyOf(e) === book);
  let failed = false;
  if (!waiting && isReachable(connectionId)) {
    try {
      return { made: await addBookmark(connectionId, libraryId, path, position, note) };
    } catch (err) {
      if (!worthKeeping(err)) throw err;
      noteFailure(connectionId, err);
      failed = true;
    }
  }
  // Fresh unless the add just tried may have landed.
  const queued = await append({ connectionId, libraryId, path, position, note }, since, !failed);
  // Sent now behind the ones waiting when the server is up; after a failure just now, on
  // the backoff (its reconnect sends it when it is down).
  if (failed) scheduleRetry();
  else void flushBookmarks(connectionId).catch(() => undefined);
  return { queued };
}

/**
 * Keep a bookmark in the outbox and send it from there, never straight to the server: stored
 * before any request, so an app killed while one is out still has it, and shown as waiting
 * until a replay has sent it, once, under the replay's claim (its read before the send keeps
 * one a replay already sent from being made twice: a delete's Undo, whose bookmark a replay
 * may have sent just before the delete). A labelled one waits for its server's flags
 * (`readLabelFlag`). Rejects when the connection is gone or the device could not store it.
 */
export async function queueBookmark(
  connectionId: string,
  libraryId: number,
  path: string,
  position: number,
  note = '',
  label?: BookmarkLabel,
): Promise<QueuedBookmark> {
  if (!resolveClient(connectionId)) throw new Error('connection gone');
  return enqueue(
    { connectionId, libraryId, path, position, note, ...(label ? { label } : {}) },
    connectionGeneration(connectionId),
    false,
  );
}

/** Store a bookmark (`append`), then send what waits for its connection. */
async function enqueue(fields: NewEntry, since: number, fresh: boolean): Promise<QueuedBookmark> {
  const queued = await append(fields, since, fresh);
  void flushBookmarks(fields.connectionId).catch(() => undefined);
  return queued;
}

/**
 * `queueBookmark` for a bookmark just made that nobody is awake to make again (the sleep
 * timer's "Fell asleep"). No send of it has gone out, so no bookmark its server already holds
 * is taken for it, however near (`fresh`: the night before's at the same second is another).
 * When the device can't store it, it is posted straight away, once, rather than lost, its
 * label on flags read first when they are not known (nothing would hold it for them). Rejects
 * when the connection is gone, or the device could not store it and that post failed too.
 */
export async function queueNewBookmark(
  connectionId: string,
  libraryId: number,
  path: string,
  position: number,
  note = '',
  label?: BookmarkLabel,
): Promise<void> {
  if (!resolveClient(connectionId)) throw new Error('connection gone');
  const since = connectionGeneration(connectionId);
  try {
    await enqueue(
      { connectionId, libraryId, path, position, note, ...(label ? { label } : {}) },
      since,
      true,
    );
  } catch (err) {
    const client = resolveClient(connectionId);
    // Gone (signed out, removed) meanwhile: nothing to post it to.
    if (!client || connectionGeneration(connectionId) !== since) throw err;
    if (label) await readLabelFlag(connectionId, client);
    await addBookmark(connectionId, libraryId, path, position, note, label);
  }
}

/** Take a waiting bookmark out of the outbox, unsent (the pending row's delete). Resolves to
 * whether it was still waiting. One whose POST a replay has already sent may still land (its
 * Undo goes through `queueBookmark` for that); one a replay claimed but has not sent yet is
 * skipped (`readyToSend`). */
export function discardQueuedBookmark(id: string): Promise<boolean> {
  return withLock(async () => {
    const queue = await readQueue();
    const next = queue.filter((e) => e.id !== id);
    if (next.length === queue.length) return false;
    await writeQueue(next);
    return true;
  });
}

// --- Sending ------------------------------------------------------------------------------

/** Whether `onServer` is at `queued`'s place: the same second, the same note. */
const atItsPlace = (onServer: Bookmark, queued: QueuedBookmark) =>
  onServer.position === queued.position && onServer.note === queued.note;

/** Whether `onServer` is `queued`, sent before (see the module): never while no send of it
 * has gone out (`fresh`); after its first, one at its place the server did not hold then
 * (`othersHeld`); else, when a send may have reached the server before it was stored, one at
 * its place made no earlier than `SAME_BOOKMARK_WINDOW_MS` before it. */
function isThisOne(onServer: Bookmark, queued: QueuedBookmark): boolean {
  if (queued.fresh || !atItsPlace(onServer, queued)) return false;
  if (queued.othersHeld) return !queued.othersHeld.includes(onServer.id);
  return Date.parse(onServer.created_at) >= Date.parse(queued.updated_at) - SAME_BOOKMARK_WINDOW_MS;
}

/** Whether the server already holds `queued` among `onServer` (the replay's rule): a waiting
 * row or pin for it would show the bookmark twice, between its send and its leaving the
 * outbox (a replay settles once every connection's sends are done), or after an add whose
 * answer was lost. */
export function heldOnServer(queued: QueuedBookmark, onServer: readonly Bookmark[]): boolean {
  return onServer.some((b) => isThisOne(b, queued));
}

/** Right before a send of `entry`: whether it is still in the stored outbox, one taken out
 * meanwhile (its row's Delete, here or in another tab, the connection's removal) is not sent.
 * Read from storage, not the snapshot, which follows another tab's writes only as their
 * `storage` events arrive. Before its first send, what the server already holds at its place
 * (`held`, the replay's read) is stored with it as not it (`othersHeld`), so a send whose
 * answer is lost is found there by the next replay. Storage that can't be read or written
 * says yes (the claim stands; the bookmark is better made than kept for ever). */
async function readyToSend(entry: QueuedBookmark, held: readonly Bookmark[]): Promise<boolean> {
  try {
    // Only a fresh one is written: the others need no lock.
    const seen = (await readQueue()).find((e) => e.id === entry.id);
    if (!seen?.fresh) return seen !== undefined;
    return await withLock(async () => {
      const queue = await readQueue();
      const stored = queue.find((e) => e.id === entry.id);
      if (!stored) return false;
      if (!stored.fresh) return true;
      const { fresh: _fresh, ...rest } = stored;
      const sending = {
        ...rest,
        othersHeld: held.filter((b) => atItsPlace(b, entry)).map((b) => b.id),
      };
      await writeQueue(queue.map((e) => (e === stored ? sending : e)));
      return true;
    });
  } catch {
    return true;
  }
}

/** A failure that is the connection's, not the bookmark's: no answer, a gateway answering
 * for a server that is away, a token refused until the connection signs in again, or nothing
 * the server said at all (the connection gone meanwhile). The connection's other bookmarks
 * would fail the same way, so the replay stops there. */
const connectionFailure = (err: unknown) =>
  !(err instanceof ApiError) || isServerAwayError(err) || isSignedOutError(err);

/** A server asking for a moment (its 503, a proxy's, a 429): the bookmark's book waits for
 * the next replay, and the wait does not count toward giving up on it (a proxy answers a
 * 503 for as long as the server behind it is off). */
const askedToWait = (err: unknown) =>
  isServerBusyError(err) || (err instanceof ApiError && err.status === 429);

/** Whether `e` has kept failing for long enough to give up on it: `GIVE_UP_MS` since its
 * first failure that counted, and `GIVE_UP_TRIES` of them before this one. */
const givenUp = (e: QueuedBookmark) =>
  e.failedSince !== undefined &&
  (e.failures ?? 0) >= GIVE_UP_TRIES &&
  Date.now() - Date.parse(e.failedSince) >= GIVE_UP_MS;

/** Record a failure that counts for the bookmarks `ids`: one more (`failures`), and when
 * the first was (`failedSince`). Storage that refuses the write leaves it uncounted. */
function noteFailing(ids: ReadonlySet<string>): Promise<void> {
  if (ids.size === 0) return Promise.resolve();
  return withLock(async () => {
    const queue = await readQueue();
    if (!queue.some((e) => ids.has(e.id))) return;
    const now = new Date().toISOString();
    await writeQueue(
      queue.map((e) =>
        ids.has(e.id)
          ? { ...e, failedSince: e.failedSince ?? now, failures: (e.failures ?? 0) + 1 }
          : e,
      ),
    );
  }).catch(() => undefined);
}

/**
 * Send one connection's claimed bookmarks, each book's in order; resolves to those to keep.
 * A bookmark that can't be sent yet holds back the rest of its book for this replay, and
 * the other books' go on past it. The read before a send drops nothing: when it fails,
 * whatever the status (a 403 or 404 too: a library not shared for now, a book away during a
 * rescan, a proxy's answer), that says nothing for good about the bookmark, so it waits.
 * Only the POST's own refusal for good drops one, and `givenUp`.
 */
async function sendGroup(
  connectionId: string,
  client: ApiClient,
  entries: QueuedBookmark[],
): Promise<QueuedBookmark[]> {
  // Per book, what its server holds: read once per replay, a failed read too.
  const reads = new Map<string, Promise<Bookmark[]>>();
  const kept: QueuedBookmark[] = [];
  // The books a bookmark that could not be sent holds back for the rest of this replay.
  const heldBack = new Set<string>();
  // Those whose failure in this replay counts toward giving up.
  const failing = new Set<string>();
  // The server's flags, when a labelled one needs them: read once per replay.
  let labelFlag: Promise<{ failed: unknown } | undefined> | undefined;
  /** After `e` failed (`err`): kept for the next replay, its failure recorded when it
   * `counts`, or given up on when such failures have gone on long enough (`givenUp`).
   * Whether it was kept. */
  const keepOrGiveUp = (e: QueuedBookmark, err: unknown, counts: boolean): boolean => {
    if (counts && givenUp(e)) {
      console.warn('[bookmarks] gave up on a queued bookmark that kept failing', err);
      return false;
    }
    kept.push(e);
    if (counts) failing.add(e.id);
    return true;
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const book = contentKeyOf(e);
    if (heldBack.has(book)) {
      kept.push(e);
      continue;
    }
    // Whether a failure is the POST's own, or comes before it (the read).
    let posting = false;
    try {
      let read = reads.get(book);
      if (!read) {
        read = client.bookmarks(e.libraryId, e.path).then((held) => held ?? []);
        reads.set(book, read);
      }
      const held = await read;
      // Already there (a send whose answer was lost, an Undo of one a replay had sent): taken
      // as sent, and shown in the book's list as a send's would be, so its waiting row and
      // pin give way to the server's bookmark rather than to nothing until the list is read.
      const already = held.find((b) => isThisOne(b, e));
      if (already) {
        showServerBookmark(connectionId, e.libraryId, e.path, already);
        continue;
      }
      // Its label goes only on flags that are known: it waits, label and all, while they
      // can't be read. What it waits for is the flags, not its turn: the book's unlabelled
      // ones behind it go on past it. The wait counts toward giving up on it as a failed send
      // would (unless the server is away, busy or waiting for a sign-in), so a server whose
      // flags never read does not keep it for ever.
      const unread = e.label
        ? await (labelFlag ??= readLabelFlag(connectionId, client))
        : undefined;
      if (unread) {
        noteFailure(connectionId, unread.failed);
        // A send's rule: nothing the server said (no answer, a cancelled read), a gateway's,
        // a 401, a 503 or a 429 does not count.
        const counts = !(connectionFailure(unread.failed) || askedToWait(unread.failed));
        keepOrGiveUp(e, unread.failed, counts);
        continue;
      }
      // Claimed by this replay, but taken out while it sent those ahead of it: the claim
      // keeps no Delete out, so the send checks, right before the POST.
      if (!(await readyToSend(e, held))) continue;
      posting = true;
      const made = await addBookmark(
        connectionId,
        e.libraryId,
        e.path,
        e.position,
        e.note,
        e.label,
      );
      // Among the book's now, for those behind it (an answer with no bookmark in it says
      // nothing to compare them with).
      if (made) held.push(made);
    } catch (err) {
      if (posting && refusedForGood(err)) {
        console.warn('[bookmarks] the server refused a queued bookmark', err);
        continue;
      }
      noteFailure(connectionId, err);
      if (connectionFailure(err)) {
        kept.push(...entries.slice(i));
        break;
      }
      const counts = !askedToWait(err);
      if (!keepOrGiveUp(e, err, counts)) continue;
      heldBack.add(book);
      // A failed read is the failure of every one of the book's; a failed POST is its own.
      if (!counts || posting) continue;
      for (const f of entries.slice(i + 1)) {
        if (contentKeyOf(f) === book) failing.add(f.id);
      }
    }
  }
  await noteFailing(failing);
  return kept;
}

/** The entries this tab sent whose removal storage refused: never sent again from here. */
const sentUnsettled = new Set<string>();

/** This tab's replays, one at a time: one asked while another is out (a sign-out's last
 * send behind a reconnect's) waits for it, then sends what is still waiting, rather than
 * finding it all claimed. */
const withReplayTurn = serialQueue();

function replay(route: (cid: string) => Route<ApiClient>): Promise<void> {
  return withReplayTurn(() =>
    replayQueue<QueuedBookmark, ApiClient>({
      lock: withLock,
      read: readQueue,
      write: writeQueue,
      route,
      send: sendGroup,
      sent: sentUnsettled,
    }),
  );
}

/** Send the waiting bookmarks of every reachable connection (or only `connectionId`'s), as
 * the stored queues do (`queuedRoute`). Waits for the session. Bookmarks another tab is
 * sending are left to it. */
export async function flushBookmarks(connectionId?: string): Promise<void> {
  if (!sessionReady()) return;
  const route =
    connectionId === undefined
      ? queuedRoute
      : (cid: string): Route<ApiClient> => (cid === connectionId ? queuedRoute(cid) : 'keep');
  // Nothing this replay would send or drop, as last read: no storage read, no lock.
  if (snapshotRead && snapshot.every((e) => route(e.connectionId) === 'keep')) {
    scheduleRetry();
    return;
  }
  try {
    await replay(route);
  } finally {
    scheduleRetry();
  }
}

/** Before a sign-out or removal is confirmed: a send of `connectionId`'s waiting bookmarks
 * while its server reads as reachable, then how many are still waiting (and would be lost). */
export async function unsentBookmarks(connectionId: string): Promise<number> {
  await flushBookmarks(connectionId).catch(() => undefined);
  return (await queuedBookmarks(connectionId)).length;
}

/** The last send before `connectionId` is signed out or removed, whatever its recorded
 * reachability (`flushConnectionSaves`). */
export async function sendBookmarksBeforeRemoval(connectionId: string): Promise<void> {
  const client = resolveClient(connectionId);
  if (!sessionReady() || !client) return;
  // None of its own waiting, as last read: no turn behind a replay still out for another
  // server (a sign-out would wait out that server's timeouts for nothing).
  if (snapshotRead && !snapshot.some((e) => e.connectionId === connectionId)) return;
  await replay(onlyConnection(connectionId, client)).catch(() => undefined);
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_MIN_MS;

/** Try again later while a reachable connection still has bookmarks waiting (its server
 * answered but failed); a server that is down is sent to on its reconnect instead, and one
 * that refuses the token (a 401: `needsReconnect`) once it is signed in again
 * (`startBookmarkSync`), rather than asked every few minutes meanwhile. */
function scheduleRetry(): void {
  const due = snapshot.some(
    (e) => queuedRoute(e.connectionId) !== 'keep' && !connectionOf(e.connectionId)?.needsReconnect,
  );
  if (!due) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = RETRY_MIN_MS;
    return;
  }
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    void flushBookmarks().catch(() => undefined);
  }, retryDelay);
}

// --- Triggers -----------------------------------------------------------------------------

/**
 * The outbox's own sending triggers, for the life of the app: every connection's bookmarks
 * once the session is ready (the launch), a connection's when its server comes back, and a
 * connection's when it is signed in again (a new token, or its reconnect flag cleared: what
 * its 401s kept waiting goes at once). The foreground, the web's focus and `online` are the
 * stored queues' (`startQueueReplays`), and the backoff is `scheduleRetry`'s. Started with
 * the root's services; returns the stop.
 */
export const startBookmarkSync = sharedStart((): (() => void) => {
  const flush = (cid?: string) => void flushBookmarks(cid).catch(() => undefined);
  const stops = [
    whenSessionReady(() => flush()),
    onReconnect((cid) => flush(cid)),
    useSession.subscribe((state, prev) => {
      if (state.connections === prev.connections) return;
      for (const c of state.connections) {
        const was = prev.connections.find((p) => p.id === c.id);
        if (was && (was.token !== c.token || (was.needsReconnect && !c.needsReconnect))) {
          flush(c.id);
        }
      }
    }),
  ];
  return () => {
    for (const stop of stops) stop();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };
});

// --- Removal ------------------------------------------------------------------------------

// Removing a connection (signing out) drops its waiting bookmarks, as its listening. Its
// sign-in ends first, before any await (the listening outbox's `connectionGeneration`): a
// bookmark made for it is not appended from here.
onConnectionRemoved(async (id) => {
  await withLock(async () => {
    const queue = await readQueue();
    const next = queue.filter((e) => e.connectionId !== id);
    if (next.length !== queue.length) await writeQueue(next);
  }).catch(() => undefined);
  // Its backoff goes with it, unless another connection's bookmarks still need it.
  scheduleRetry();
});

/** Test-only: forget what this module holds in memory. */
export function resetAnnotationOutboxForTests(): void {
  snapshot = [];
  snapshotRead = false;
  firstLoad = null;
  sentUnsettled.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_MIN_MS;
}
