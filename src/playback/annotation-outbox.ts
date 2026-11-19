import {
  type ApiClient,
  ApiError,
  isRefusedForGood,
  isSignedOutError,
  isUnreachableError,
} from '@/api/client';
import { resolveClient, sessionReady, whenSessionReady } from '@/api/connection-clients';
import { addBookmark, cachedCapability, fetchCapabilities } from '@/api/hooks';
import { isReachable, noteFailure, onReconnect } from '@/api/reachability';
import type { Bookmark, BookmarkLabel } from '@/api/types';
import { contentKeyOf } from '@/lib/content-key';
import { type Claimed, replayQueue, type Route, unclaimed } from '@/lib/queue-claims';
import { randomUUID } from '@/lib/random';
import { sharedStart } from '@/lib/shared-start';
import { serialQueue } from '@/lib/serial-queue';
import { getItemStrict, setItemStrict } from '@/lib/storage';
import { ANNOTATION_OUTBOX_KEY as KEY, isRecord } from '@/lib/storage-keys';
import { onStoredChange } from '@/lib/tab-channel';
import { tabLock } from '@/lib/tab-lock';
import { onConnectionRemoved } from '@/stores/session';

import { connectionGeneration } from './listening-outbox';
import { onlyConnection, queuedRoute } from './progress-sync';

/**
 * The bookmark outbox (fe#356): a bookmark made while its server can't take it (no answer, a
 * busy or failing server, a token it refuses until the connection signs in again) waits here
 * on the device and is sent once the server is back, instead of being refused. The same
 * guarantees as the listening outbox (`listening-outbox.ts`), on the simpler shape a bookmark
 * needs:
 *
 * - Per connection: every entry carries its `connectionId` and goes through that
 *   connection's own client.
 * - Persisted: `audiosilo.annotationOutbox`, shared by the web player's tabs (its
 *   read-modify-writes take `tabLock`, and a tab follows another's change through `storage`
 *   events). A write storage refuses throws: the caller then says the bookmark failed, as
 *   before, rather than holding one that a reload would lose.
 * - Ordered: oldest first per connection. A new bookmark goes behind any still waiting for
 *   its server, and a replay stops at the first that can't be sent yet.
 * - Retried: at launch and on the server's reconnect (`startBookmarkSync`), with the stored
 *   queues in the foreground and on the web's focus and `online` (`startQueueReplays`), and
 *   with a backoff while the server answers but fails (`scheduleRetry`). A replay claims what
 *   it sends (`replayQueue`, `src/lib/queue-claims.ts`), so two tabs never send the same
 *   bookmark at once.
 * - Sent once: the server's bookmark POST has no idempotency key, and a request that got no
 *   answer may still have landed (or a tab may have died mid-send). So a replay reads the
 *   book's bookmarks first and takes one already there (the same second, the same note, made
 *   no earlier than a day before this one) as this bookmark, sent.
 * - Dropped on sign-out and when a connection is removed (`onConnectionRemoved`), like the
 *   listening outbox, after a last send while the token still works
 *   (`sendBookmarksBeforeRemoval`, in `flushConnectionSaves`): signing in again starts from
 *   the server's record. One made before the removal and appended after it is not appended
 *   (`since`). An entry whose connection is gone once the session has loaded (a storage
 *   reset) is dropped by the next replay (`queuedRoute`: not while an identity move is on its
 *   way).
 *
 * A bookmark the server refuses for good (a 4xx other than 401, 408 and 429: the book is gone
 * or out of the account's reach) is dropped, logged. Labels follow `postBookmark`'s rule at
 * send time (`addBookmark`); a replay with a label reads the server's flags first when they
 * are not known yet, so the label is not dropped just because `/server` was not read again.
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
};

/** What `addBookmarkOrQueue` did: made on the server, or kept here to send later. */
type AddBookmarkOutcome = { made: Bookmark } | { queued: QueuedBookmark };

/** A bookmark on the server counts as a queued one sent earlier when it was made no earlier
 * than this before it (the server's clock may be a little behind the device's). */
const SAME_BOOKMARK_WINDOW_MS = 24 * 60 * 60_000;
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
  (v.label === undefined || typeof v.label === 'string');

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

const sameEntries = (a: readonly QueuedBookmark[], b: readonly QueuedBookmark[]) =>
  a.length === b.length && a.every((e, i) => e.id === b[i].id);

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

type NewEntry = Omit<QueuedBookmark, 'id' | 'updated_at'>;

/** Append a bookmark behind every other one waiting. Rejects when its connection was removed
 * since `since` (its sign-in, `connectionGeneration`), or when storage refused the write. */
function append(fields: NewEntry, since: number): Promise<QueuedBookmark> {
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

/**
 * Add a bookmark to a book on ONE connection's server, or keep it on the device when the
 * server can't take it now (see the module). Straight to the server when nothing is waiting
 * for it and it reads as reachable (`addBookmark`, which refreshes the book's lists);
 * otherwise, or when that fails with a failure worth another try, it goes into the outbox.
 * Rejects when the connection is gone, the server refused it for good, or the device could
 * not store it.
 */
export async function addBookmarkOrQueue(
  connectionId: string,
  libraryId: number,
  path: string,
  position: number,
  note = '',
  label?: BookmarkLabel,
): Promise<AddBookmarkOutcome> {
  if (!resolveClient(connectionId)) throw new Error('connection gone');
  const since = connectionGeneration(connectionId);
  // Behind any still waiting for this server: they reach it in the order they were made. The
  // copy here once read (another tab's changes reach it through `storage` events).
  const queue = snapshotRead ? snapshot : await readQueue().catch(() => snapshot);
  const waiting = queue.some((e) => e.connectionId === connectionId);
  let failed = false;
  if (!waiting && isReachable(connectionId)) {
    try {
      return { made: await addBookmark(connectionId, libraryId, path, position, note, label) };
    } catch (err) {
      if (!worthKeeping(err)) throw err;
      noteFailure(connectionId, err);
      failed = true;
    }
  }
  const queued = await append(
    { connectionId, libraryId, path, position, note, ...(label ? { label } : {}) },
    since,
  );
  // Sent now behind the ones waiting when the server is up; after a failure just now, on
  // the backoff (its reconnect sends it when it is down).
  if (failed) scheduleRetry();
  else void flushBookmarks(connectionId).catch(() => undefined);
  return { queued };
}

/** Take a waiting bookmark out of the outbox, unsent (the pending row's delete). Resolves to
 * whether it was still waiting. One a replay is sending right now may still land. */
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

/** Whether `onServer` is `queued`, sent before (see the module). */
function isThisOne(onServer: Bookmark, queued: QueuedBookmark): boolean {
  return (
    onServer.position === queued.position &&
    onServer.note === queued.note &&
    Date.parse(onServer.created_at) >= Date.parse(queued.updated_at) - SAME_BOOKMARK_WINDOW_MS
  );
}

/** Send one connection's claimed bookmarks in order; resolves to those to keep. */
async function sendGroup(
  connectionId: string,
  client: ApiClient,
  entries: QueuedBookmark[],
): Promise<QueuedBookmark[]> {
  // Per book, what its server holds (read once per replay).
  const onServer = new Map<string, Bookmark[]>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    try {
      const book = contentKeyOf(e);
      let held = onServer.get(book);
      if (!held) {
        held = (await client.bookmarks(e.libraryId, e.path)) ?? [];
        onServer.set(book, held);
      }
      if (held.some((b) => isThisOne(b, e))) continue;
      if (e.label && cachedCapability(connectionId, 'annotations') === undefined) {
        await fetchCapabilities(connectionId, client).catch(() => undefined);
      }
      held.push(await addBookmark(connectionId, e.libraryId, e.path, e.position, e.note, e.label));
    } catch (err) {
      if (refusedForGood(err)) {
        console.warn('[bookmarks] the server refused a queued bookmark', err);
        continue;
      }
      noteFailure(connectionId, err);
      return entries.slice(i);
    }
  }
  return [];
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
  await replay(onlyConnection(connectionId, client)).catch(() => undefined);
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_MIN_MS;

/** Try again later while a reachable connection still has bookmarks waiting (its server
 * answered but failed); a server that is down is sent to on its reconnect instead. */
function scheduleRetry(): void {
  const due = snapshot.some((e) => queuedRoute(e.connectionId) !== 'keep');
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
 * once the session is ready (the launch) and a connection's when its server comes back. The
 * foreground, the web's focus and `online` are the stored queues' (`startQueueReplays`), and
 * the backoff is `scheduleRetry`'s. Started with the root's services; returns the stop.
 */
export const startBookmarkSync = sharedStart((): (() => void) => {
  const stops = [
    whenSessionReady(() => void flushBookmarks().catch(() => undefined)),
    onReconnect((cid) => void flushBookmarks(cid).catch(() => undefined)),
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
