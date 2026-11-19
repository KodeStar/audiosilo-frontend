import { Platform } from 'react-native';

import { networkChecked } from '@/api/address-route';
import {
  type ApiClient,
  ApiError,
  isRefusedForGood,
  isSignedOutError,
  isUnreachableError,
} from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { addBookmark, cachedCapability, fetchCapabilities } from '@/api/hooks';
import { isReachable, noteFailure, onReconnect } from '@/api/reachability';
import type { Bookmark, BookmarkLabel } from '@/api/types';
import { contentKeyOf } from '@/lib/content-key';
import { type Claimed, replayQueue, type Route, unclaimed } from '@/lib/queue-claims';
import { randomUUID } from '@/lib/random';
import { sharedStart } from '@/lib/shared-start';
import { getItemStrict, setItemStrict } from '@/lib/storage';
import { ANNOTATION_OUTBOX_KEY as KEY, isRecord } from '@/lib/storage-keys';
import { onStoredChange } from '@/lib/tab-channel';
import { tabLock } from '@/lib/tab-lock';
import { onForeground } from '@/lib/when-active';
import { onConnectionRemoved, useSession } from '@/stores/session';

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
 * - Retried: at launch, on the server's reconnect, in the foreground, on the browser's
 *   `online`, and with a backoff while the server answers but fails (`startBookmarkSync`).
 *   A replay claims what it sends (`replayQueue`, `src/lib/queue-claims.ts`), so two tabs
 *   never send the same bookmark at once.
 * - Sent once: the server's bookmark POST has no idempotency key, and a request that got no
 *   answer may still have landed (or a tab may have died mid-send). So a replay reads the
 *   book's bookmarks first and takes one already there (the same second, the same note, made
 *   no earlier than a day before this one) as this bookmark, sent.
 * - Dropped on sign-out and when a connection is removed (`onConnectionRemoved`), like the
 *   listening outbox: signing in again starts from the server's record. One made before the
 *   removal and appended after it is not appended (`since`). An entry whose connection is
 *   gone once the session has loaded (a storage reset) is dropped by the next replay.
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

/** Read the stored queue once, for the first screen that shows it. */
export function loadQueuedBookmarks(): Promise<void> {
  if (snapshotRead) return Promise.resolve();
  return readQueue().then(
    () => undefined,
    () => undefined,
  );
}

/** The bookmarks waiting for `connectionId`'s server, oldest first (all when absent). */
export async function queuedBookmarks(connectionId?: string): Promise<QueuedBookmark[]> {
  const queue = (await readQueue()).map((e) => unclaimed(e));
  return connectionId === undefined ? queue : queue.filter((e) => e.connectionId === connectionId);
}

// --- Adding -------------------------------------------------------------------------------

/** How many times each connection was removed this launch (its purge, below): a bookmark
 * made before a removal is not appended after it (`since`). */
const removals = new Map<string, number>();

const generationOf = (connectionId: string) => removals.get(connectionId) ?? 0;

type NewEntry = Omit<QueuedBookmark, 'id' | 'updated_at'>;

/** Append a bookmark behind every other one waiting. Rejects when its connection was removed
 * since `since`, or when storage refused the write. */
function append(fields: NewEntry, since: number): Promise<QueuedBookmark> {
  return withLock(async () => {
    if (generationOf(fields.connectionId) !== since) throw new Error('connection gone');
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

/** Whether a failed add is worth keeping to send later: no answer, a server failing or
 * asking for a moment (5xx, 408, 429), or a token it refuses until the connection signs in
 * again (401). Not a refusal for good, nor a code bug. */
function worthKeeping(err: unknown): boolean {
  if (isUnreachableError(err) || isSignedOutError(err)) return true;
  return err instanceof ApiError && !isRefusedForGood(err);
}

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
  const since = generationOf(connectionId);
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
      if (isRefusedForGood(err) && !isSignedOutError(err)) {
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

/** Where a connection's bookmarks go in a replay: its client (only `only`'s when given, and
 * only while it reads as reachable unless `force`), kept, or dropped once the session has
 * loaded without it. */
function routeFor(only?: string, force = false): (cid: string) => Route<ApiClient> {
  return (cid) => {
    if (only !== undefined && cid !== only) return 'keep';
    const client = resolveClient(cid);
    if (!client) return sessionReady() ? 'drop' : 'keep';
    return force || isReachable(cid) ? { send: client } : 'keep';
  };
}

/** This tab's replays still running (a sign-out's last send waits for them). */
const replays = new Set<Promise<void>>();

function replay(route: (cid: string) => Route<ApiClient>): Promise<void> {
  const run = replayQueue<QueuedBookmark, ApiClient>({
    lock: withLock,
    read: readQueue,
    write: (next) => writeQueue(next),
    route,
    send: sendGroup,
    sent: sentUnsettled,
  });
  replays.add(run);
  void run.finally(() => replays.delete(run)).catch(() => undefined);
  return run;
}

/** Send the waiting bookmarks of every reachable connection (or only `connectionId`'s).
 * Waits for the session. Bookmarks another tab is sending are left to it. */
export async function flushBookmarks(connectionId?: string): Promise<void> {
  if (!sessionReady()) return;
  try {
    await replay(routeFor(connectionId));
  } finally {
    scheduleRetry();
  }
}

/**
 * The last send before `connectionId` is signed out or removed, whatever its recorded
 * reachability, then how many of its bookmarks are still waiting (and would be dropped).
 */
export async function unsentBookmarks(connectionId: string): Promise<number> {
  // A replay running here holds what it sends (its claims): it ends first.
  await Promise.allSettled([...replays]);
  if (sessionReady() && resolveClient(connectionId)) {
    await replay(routeFor(connectionId, true)).catch(() => undefined);
  }
  return (await queuedBookmarks(connectionId).catch(() => [])).length;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_MIN_MS;

/** Try again later while a reachable connection still has bookmarks waiting (its server
 * answered but failed); a server that is down is sent to on its reconnect instead. */
function scheduleRetry(): void {
  const due = snapshot.some((e) => isReachable(e.connectionId) && resolveClient(e.connectionId));
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

type Win = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * The outbox's sending triggers, for the life of the app: every connection's bookmarks once
 * the session is ready (the launch), a connection's when its server comes back, all of them
 * in the foreground (once `networkChecked`, as the listening outbox) and, on the web, when the
 * browser is back online. Started with the root's services; returns the stop.
 */
export const startBookmarkSync = sharedStart(
  (
    win: Win | undefined = Platform.OS === 'web'
      ? (globalThis as { window?: Win }).window
      : undefined,
  ): (() => void) => {
    const flushAll = () => void flushBookmarks().catch(() => undefined);
    const stops: (() => void)[] = [];
    if (sessionReady()) flushAll();
    else {
      stops.push(
        useSession.subscribe((state, prev) => {
          if (prev.status === 'loading' && state.status !== 'loading' && sessionReady()) {
            flushAll();
          }
        }),
      );
    }
    stops.push(onReconnect((cid) => void flushBookmarks(cid).catch(() => undefined)));
    stops.push(onForeground(() => void networkChecked().then(flushAll)));
    if (typeof win?.addEventListener === 'function') {
      win.addEventListener('online', flushAll);
      stops.push(() => win.removeEventListener('online', flushAll));
    }
    return () => {
      for (const stop of stops) stop();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };
  },
);

// --- Removal ------------------------------------------------------------------------------

// Removing a connection (signing out) drops its waiting bookmarks, as its listening.
onConnectionRemoved(async (id) => {
  // First, before any await: a bookmark made for this sign-in is not appended from here.
  removals.set(id, generationOf(id) + 1);
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
  removals.clear();
  sentUnsettled.clear();
  replays.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_MIN_MS;
}
