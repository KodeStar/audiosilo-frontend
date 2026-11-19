import {
  ApiError,
  type ApiClient,
  isRefusedForGood,
  isSignedOutError,
  TimeoutError,
} from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { noteRateLimit, onRateLimitOver, rateLimited, stopsReplay } from '@/api/rate-limit';
import { isReachable, noteFailure, noteSuccess } from '@/api/reachability';
import type { ReadingProgress, ReadingProgressSaved } from '@/api/types';
import { contentKey, contentKeyOf, isKeyOf } from '@/lib/content-key';
import { type Claimed, claimStands, queuedKey, replayQueue, type Route } from '@/lib/queue-claims';
import { keyedSerialQueue, serialQueue } from '@/lib/serial-queue';
import { getItem, setItem, setItemStrict } from '@/lib/storage';
import { READING_MIRROR_KEY, READING_QUEUE_KEY } from '@/lib/storage-keys';
import { tabLock } from '@/lib/tab-lock';
import { getDeviceId, onlyConnection, queuedRoute } from '@/playback/progress-sync';
import { onConnectionRemoved } from '@/stores/session';

import { clearEbookCache } from './ebook-file';

/**
 * The ebook reader's place, saved per user on the server (Bridge Phase 3b,
 * `/libraries/{id}/reading-progress`), the way `src/playback/progress-sync.ts` saves the
 * listening place: an offline queue keeping the latest save per (connection, library,
 * book path) and replayed through each save's own connection, a durable mirror that is
 * never pruned on sync, and a 4xx dropped (it can never succeed).
 *
 * One thing it adds: `base_version`, the server's `version` of the place this device last
 * saw (acknowledged). The server bumps the version on every write it applies, so a save
 * from another device made on an older version is DIVERGED, and so is any save made on 0
 * (saw nothing, this device's own row included: its id outlives the places kept here), and
 * the server keeps the further of the two places instead of moving the reader back. An
 * answer that kept this very save is acknowledged at once (`version` in the mirror); one
 * that kept a place this device never saw (another device's, or its own from before its
 * places here were cleared) only once the open reader has shown it (`adoptServerPlace`:
 * Jump, Stay, or the reader is already there). Until then this device's saves stay
 * diverged, so a place it never saw is never moved back, and after Stay its next save
 * applies: moving back on purpose works. Separate from listening progress on purpose.
 */

/** A place in the book, as the server and the mirror keep it. */
export type ReadingPlace = {
  cfi: string;
  progression: number;
  device_id: string;
  updated_at: string;
};

/** The mirror's record for one book: the newest place this device knows of (by
 * `updated_at`) and the server version it last acknowledged (0 = none). `own`: that version
 * is this device's own save's, acknowledged from its answer, not one the reader adopted
 * from elsewhere (`adoptServerPlace`); absent in a record from an older build (taken as
 * not). */
type MirrorEntry = {
  connectionId: string;
  libraryId: number;
  path: string;
  place: ReadingPlace | null;
  version: number;
  own?: boolean;
};

/** One save, captured with its `updated_at` and `base_version` so an offline replay says
 * when it was made and what it was made on. */
export type ReadingSave = ReadingPlace & {
  connectionId: string;
  libraryId: number;
  path: string;
  base_version: number;
};

/** A save the server answered: the book it was for and the answer. `seen`: this device
 * had seen the kept row (it is this save, or this device's own row at a version it had
 * acknowledged), so there is nothing to offer; otherwise the row waits for the open reader
 * to show it (`jumpOffer`, then `adoptServerPlace`). */
export type ReadingSaved = {
  connectionId: string;
  libraryId: number;
  path: string;
  saved: ReadingProgressSaved;
  seen: boolean;
};

const timeOf = (p: { updated_at: string }) => {
  const t = Date.parse(p.updated_at);
  return Number.isNaN(t) ? 0 : t;
};

const placeOf = (p: ReadingPlace): ReadingPlace => ({
  cfi: p.cfi,
  progression: p.progression,
  device_id: p.device_id,
  updated_at: p.updated_at,
});

/** Same book: connection, library and path. */
const sameBook = (
  a: { connectionId: string; libraryId: number; path: string },
  b: { connectionId: string; libraryId: number; path: string },
) => a.connectionId === b.connectionId && a.libraryId === b.libraryId && a.path === b.path;

// --- the durable mirror ------------------------------------------------------------------

async function readMirrorMap(): Promise<Record<string, MirrorEntry>> {
  return (await getItem<Record<string, MirrorEntry>>(READING_MIRROR_KEY)) ?? {};
}

// The mirror's read-modify-writes one at a time, in this tab and across tabs (`tabLock`): the
// tabs of the web player write one mirror, and a lock per tab let one tab write its read of
// the whole mirror over another tab's change made meanwhile.
const withMirrorLock = tabLock(READING_MIRROR_KEY);

/** Change one book's mirror record (created empty when absent). */
async function updateMirror(
  book: { connectionId: string; libraryId: number; path: string },
  change: (entry: MirrorEntry) => MirrorEntry,
): Promise<void> {
  await withMirrorLock(async () => {
    const map = await readMirrorMap();
    const key = contentKey(book.connectionId, book.libraryId, book.path);
    const entry = map[key] ?? {
      connectionId: book.connectionId,
      libraryId: book.libraryId,
      path: book.path,
      place: null,
      version: 0,
    };
    map[key] = change(entry);
    await setItem(READING_MIRROR_KEY, map);
  });
}

/** Keep `place` when it is newer (by `updated_at`) than the mirror's. */
const withNewerPlace =
  (place: ReadingPlace) =>
  (entry: MirrorEntry): MirrorEntry =>
    !entry.place || timeOf(place) >= timeOf(entry.place)
      ? { ...entry, place: placeOf(place) }
      : entry;

/** Take the server's `row` as seen: its place when newer, and its version (`own`: the
 * answer to this device's own save, not a place adopted from elsewhere). */
const acknowledged =
  (row: ReadingProgress, own: boolean) =>
  (entry: MirrorEntry): MirrorEntry => ({
    ...withNewerPlace(row)(entry),
    version: row.version,
    own,
  });

/** Whether this device has seen the server's `row`: the very version it acknowledged (that
 * row: a version is one write), or its own row at a version it had acknowledged. */
const seenBy = (row: ReadingProgress, entry: MirrorEntry | null, deviceId: string) =>
  entry !== null &&
  (row.version === entry.version || (row.device_id === deviceId && row.version <= entry.version));

/** Whether the server takes `save` as diverged from its stored `row` (catalog.ResolvePlace):
 * made on another version than the row's, by another device than the row's or on 0 (saw
 * nothing, whatever the device). */
const diverges = (save: ReadingSave, row: ReadingProgress) =>
  save.base_version !== row.version &&
  (save.base_version === 0 || save.device_id !== row.device_id);

async function readMirror(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<MirrorEntry | null> {
  return (await readMirrorMap())[contentKey(connectionId, libraryId, path)] ?? null;
}

// --- where to open -------------------------------------------------------------------------

/** Where the reader opens a book: the newest place (by `updated_at`) of the server's row,
 * the mirror and the offline queue, except that a queued save the server will keep (one
 * that diverged and is further on) beats the row, however old; `fromServer` when it is
 * the server's row (then the reader adopts it with `adoptServerPlace`). `unseen`: opening
 * at a local place, the server's row when this device has not seen it (another device's
 * kept place, after an offline session's replay from Home answered while no reader was
 * open), so the open offers Jump there at once as that answer would have (fe#173), not at
 * the first page turn's save. Only a row further on than the place it opens at: one behind
 * it is a place the server gives up to this device's next save (diverged, the further
 * kept), never one to go back to. Not while a save of the book is queued: the reader
 * replays it as it opens, and that answer says what the server kept. The local places are
 * read once the server answered and any save of the book in flight is answered too (its
 * send turn, `withSendTurn`): read before, the answer of a save in flight was not in them,
 * and the row it acknowledged was offered back as unseen. A row older than the version this
 * device acknowledged (an answer read before a save of the book overtook it) counts as no
 * row at all: the server no longer holds it, so the reader neither opens there nor offers it
 * (opened there, its next save moved the place the server had kept back).
 * `place` null: none anywhere, open at the start. With no answer from the server, this
 * device's own places stand; with none either, the lookup fails (throws the request's
 * error) instead of opening at the start: a start saved over a place read elsewhere would
 * replace it. A 401 always fails it (the token is dead).
 *
 * Except offline with the book on this device (`hasLocalCopy`: its download or the app's
 * cache holds the EPUB): a request that never reached the server opens it at the start,
 * so a downloaded book reads offline the first time. A timed-out one opens it so only once
 * the reachability check has found the server down too: a slow server is up, and may hold
 * a place further on (fe#173), but one whose every request hangs (a home address away from
 * home) is not. No place was ever seen here, so the session's saves carry
 * `base_version: 0` (`captureReadingSave`), which the server takes as diverged from any
 * row, this device's own included (its id outlives its places here: signed out and back
 * in): it keeps a place further on and the answer offers Jump there (`jumpOffer`). An
 * answer from the server (an `ApiError`) still fails it: online, never a guessed start. */
export type ReadingPlaceLookup = {
  place: ReadingPlace | null;
  fromServer: ReadingProgress | null;
  unseen: ReadingProgress | null;
};

export async function lookupReadingPlace(
  api: ApiClient | null,
  connectionId: string,
  libraryId: number,
  path: string,
  signal?: AbortSignal,
  { hasLocalCopy }: { hasLocalCopy?: () => Promise<boolean> } = {},
): Promise<ReadingPlaceLookup> {
  let server: ReadingProgress | null = null;
  // Why the server's place is unknown (no client, or the request failed); null: it answered.
  let unknown: unknown = api ? null : new Error('no client for this connection');
  if (api) {
    try {
      server = await api.readingProgress(libraryId, path, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      // A dead token is never masked by the local places: the client flagged it, and a
      // lookup that succeeded anyway would clear that flag (provider.tsx).
      if (isSignedOutError(e)) throw e;
      // An ApiError is an answer (it is up); anything else only asks for a check.
      if (e instanceof ApiError) noteSuccess(connectionId);
      else noteFailure(connectionId, e);
      unknown = e;
    }
  }
  const book = { connectionId, libraryId, path };
  const [mirror, queue] = await withSendTurn(contentKeyOf(book), () =>
    Promise.all([readMirror(connectionId, libraryId, path), readQueue()]),
  );
  // A save this tab sent or had refused since it was queued is not one the reader replays.
  const queued = queue.find((s) => sameBook(s, book) && !settledHere(s)) ?? null;
  // A row older than the version this device acknowledged was read before a save of the book
  // overtook it (the open's own replay, answered while the lookup waited its turn): the
  // server no longer holds it, so it is neither where to open nor a place to offer.
  if (server && server.version < (mirror?.version ?? 0)) server = null;
  let best: ReadingPlace | null = server;
  for (const place of [mirror?.place ?? null, queued]) {
    if (place && (!best || timeOf(place) > timeOf(best))) best = place;
  }
  if (queued && server && diverges(queued, server) && queued.progression > server.progression) {
    best = queued;
  }
  if (!best && unknown !== null) {
    const offline =
      api !== null &&
      !(unknown instanceof ApiError) &&
      !(unknown instanceof TimeoutError && isReachable(connectionId));
    if (!offline || !(await localCopy(hasLocalCopy))) throw unknown;
  }
  const fromServer = best !== null && best === server ? server : null;
  const unseen =
    server &&
    best &&
    !fromServer &&
    !queued &&
    server.progression > best.progression &&
    !seenBy(server, mirror, await getDeviceId())
      ? server
      : null;
  return { place: best ? placeOf(best) : null, fromServer, unseen };
}

/** Whether the book's EPUB is on this device; a check that fails says no. */
async function localCopy(check?: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await check?.()) === true;
  } catch {
    return false;
  }
}

/** The open reader's acknowledgements (`adoptServerPlace`) and captures (`saveReaderPlace`),
 * one after another in the order they were asked for: a save asked for after a place was
 * acknowledged is made on that version. A capture reads the version before its own awaits
 * are over, so one started while the acknowledgement was still being written (the save a
 * Jump's move makes, flushed as the reader closes; a page turned as the reader finds itself
 * already there) went on the old version, and the server kept it as the other place again. */
const withReaderPlaceLock = serialQueue();

/** The reader has shown the server's `row` (it opened there; or another device's kept place
 * was answered with Jump or Stay, or the reader is already there): this device has seen that
 * version, so its saves are made on it (and the mirror keeps the place). Every reader save
 * asked for from here on is (`withReaderPlaceLock`). */
export async function adoptServerPlace(
  connectionId: string,
  libraryId: number,
  path: string,
  row: ReadingProgress,
): Promise<void> {
  await withReaderPlaceLock(() =>
    updateMirror({ connectionId, libraryId, path }, acknowledged(row, false)),
  );
}

// --- saving ----------------------------------------------------------------------------------

/** Per book (`contentKey`), when this tab's last capture of it was made (ms): a capture is
 * later, so two pages turned in one millisecond are two saves. The queue (`queuedKey`, the
 * newest per book) and `settledUntil` tell a book's saves apart by their time; with one time,
 * the answer to the first dropped the second's queued copy as sent. */
const lastCaptured = new Map<string, number>();

/** A save of `place` now, made on the version this device last acknowledged. */
export async function captureReadingSave(
  connectionId: string,
  libraryId: number,
  path: string,
  place: { cfi: string; progression: number },
): Promise<ReadingSave> {
  const mirror = await readMirror(connectionId, libraryId, path);
  const key = contentKey(connectionId, libraryId, path);
  const now = Date.now();
  const last = lastCaptured.get(key) ?? -Infinity;
  // Within a second of the last: not a clock set back, which captures follow.
  const at = now <= last && last - now < 1000 ? last + 1 : now;
  lastCaptured.set(key, at);
  return {
    connectionId,
    libraryId,
    path,
    cfi: place.cfi,
    progression: Math.min(1, Math.max(0, place.progression)),
    device_id: await getDeviceId(),
    updated_at: new Date(at).toISOString(),
    base_version: mirror?.version ?? 0,
  };
}

/** The open reader's save of `place`: captured now, behind any acknowledgement asked for
 * before it (`withReaderPlaceLock`), and saved (`saveReadingPlace`). */
export async function saveReaderPlace(
  api: ApiClient | null,
  connectionId: string,
  libraryId: number,
  path: string,
  place: { cfi: string; progression: number },
): Promise<ReadingProgressSaved | null> {
  const captured = await withReaderPlaceLock(() =>
    captureReadingSave(connectionId, libraryId, path, place),
  );
  return saveReadingPlace(api, captured);
}

type SavedListener = (saved: ReadingSaved) => void;
const savedListeners = new Set<SavedListener>();

/** Every answered save, a queued one's replay included: the open reader offers to jump to
 * another device's place from it (`jumpOffer`). Returns the unsubscribe. */
export function onReadingSaved(listener: SavedListener): () => void {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}

/** A save the server refused (a 4xx: the sign-in ended, the book or the access went), so
 * it was dropped: the place stays in this device's mirror only. */
export type ReadingRefused = {
  connectionId: string;
  libraryId: number;
  path: string;
  status: number;
};

type RefusedListener = (refused: ReadingRefused) => void;
const refusedListeners = new Set<RefusedListener>();

/** Every save the server refused, a queued one's replay included: the open reader says its
 * place was not saved. Returns the unsubscribe. */
export function onReadingRefused(listener: RefusedListener): () => void {
  refusedListeners.add(listener);
  return () => {
    refusedListeners.delete(listener);
  };
}

/** A save dropped for `e` (`isRefusedForGood`; a 408 or a 429 is queued for the replay like a
 * failed request), told to the listeners. */
function refused(save: ReadingSave, e: ApiError): void {
  const heard: ReadingRefused = {
    connectionId: save.connectionId,
    libraryId: save.libraryId,
    path: save.path,
    status: e.status,
  };
  for (const listener of refusedListeners) listener(heard);
}

/** PUT one save, keep the answer's place when newer, tell listeners. Its version is
 * acknowledged when the server kept this save; any other kept row is `seen` only when it is
 * this device's own at a version it had acknowledged, else it waits for the open reader to
 * show it (`adoptServerPlace`), and no reader may be open (a replay from Home, or the
 * close-save answered after the reader went). */
async function put(client: ApiClient, save: ReadingSave): Promise<ReadingProgressSaved> {
  const saved = await client.saveReadingProgress(save.libraryId, save.path, {
    cfi: save.cfi,
    progression: save.progression,
    device_id: save.device_id,
    updated_at: save.updated_at,
    base_version: save.base_version,
  });
  const row = saved.reading_progress;
  const own = row.device_id === save.device_id;
  // This save's place, not its time: the server replaces an updated_at too far ahead of its
  // clock with its own (plausibleUpdatedAt), and an own row at the same place is seen anyway.
  const thisSave = own && row.cfi === save.cfi && row.progression === save.progression;
  let seen = false;
  await updateMirror(save, (entry) => {
    seen = thisSave || seenBy(row, entry, save.device_id);
    return thisSave ? acknowledged(row, true)(entry) : withNewerPlace(row)(entry);
  });
  const answer: ReadingSaved = {
    connectionId: save.connectionId,
    libraryId: save.libraryId,
    path: save.path,
    saved,
    seen,
  };
  for (const listener of savedListeners) listener(answer);
  return saved;
}

/**
 * Save `save` (a capture, `captureReadingSave`): the mirror takes its place at once, and it
 * is sent once every save of its book before it is answered, the offline queue's replays
 * included (`withSendTurn`); with no client, an unreachable server, a server that asked to
 * wait (a 429, `rateLimited`) or a failed request, it is queued for replay (a 4xx but a 408
 * or a 429 is dropped: it can never succeed; `onReadingRefused` hears it). A save made on 0
 * is sent on the version an answer to this device's own save acknowledged meanwhile: two
 * first saves on 0 in flight together would diverge from each other (catalog.ResolvePlace),
 * so a move back would be kept as the other place. Never on one adopted meanwhile (Jump,
 * Stay, the reader already there: `own` false): a page captured before the Jump, sent on the
 * place jumped to, would apply and move that place back (fe#173); on 0 it diverges, and the
 * server keeps the further. Resolves the server's answer, or null when it was queued,
 * dropped, or a newer save of the book was asked for while it waited (that one carries the
 * place).
 */
export async function saveReadingPlace(
  api: ApiClient | null,
  save: ReadingSave,
): Promise<ReadingProgressSaved | null> {
  await updateMirror(save, withNewerPlace(save));
  return sendThenFlush(api, save);
}

/** The latest save asked for per book (`contentKey`), by the order asked: a save whose turn
 * comes once a newer one of its book is waiting behind it is not sent, so the saves held
 * behind a request that hangs (up to its timeout) go as one, not one timeout after another. */
const latestAsked = new Map<string, object>();

/** Made on 0, `save` on the version an answer to this device's own save acknowledged
 * meanwhile (`saveReadingPlace`), whether the reader's turn or a replay sends it. */
async function onOwnVersion(save: ReadingSave): Promise<ReadingSave> {
  if (save.base_version) return save;
  const entry = await readMirror(save.connectionId, save.libraryId, save.path);
  return entry?.own ? { ...save, base_version: entry.version } : save;
}

/** Send `save` once it holds its book's `withSendTurn`, or queue it; after a sent save,
 * replay what is still queued. A save sent or refused supersedes a
 * queued save of the same book made before it: the latest save per book wins, sent or
 * queued, so a replay never follows it with an older place (one made on 0 that is further on
 * would be kept, a place the reader had left). Such a save is replaced in the queue by this
 * one before the request goes (`queueAhead`), not only once it is answered: a request the
 * app was closed under left the older place to be replayed. A save that has to wait for its
 * turn (a save of its book still on its way, up to the client's timeout) is queued as it
 * starts to wait (`queueSave`), not only once its turn comes: the app closed meanwhile, the
 * server kept the older page until this device's next save of the book. In its turn it is
 * sent only while that queued copy is still there, unclaimed or claimed by a replay of this
 * tab's (`waitingUnclaimed`): one another tab's replay claimed meanwhile is that replay's to
 * send (here too, it went twice), and one that left the queue went from another tab or gave
 * way to a newer save. */
async function sendThenFlush(
  api: ApiClient | null,
  captured: ReadingSave,
): Promise<ReadingProgressSaved | null> {
  const key = contentKeyOf(captured);
  const turn = {};
  latestAsked.set(key, turn);
  // Asked before the turn is: once it is, the book always has a job.
  const waiting = withSendTurn.busy(key)
    ? queueSave(captured, setItemStrict).catch(() => false)
    : null;
  const { saved, more } = await withSendTurn(key, async () => {
    if (latestAsked.get(key) !== turn) return { saved: null, more: false };
    // One storage refused to queue is sent as any save.
    if (waiting && (await waiting) && !(await waitingUnclaimed(captured))) {
      return { saved: null, more: false };
    }
    const save = await onOwnVersion(captured);
    if (!api || !isReachable(save.connectionId) || rateLimited(save.connectionId)) {
      await queueSave(save);
      return { saved: null, more: false };
    }
    await queueAhead(save);
    try {
      const answer = await put(api, save);
      noteSuccess(save.connectionId);
      noteSettled(save);
      return { saved: answer, more: await dropQueuedBefore(save) };
    } catch (e) {
      if (isRefusedForGood(e)) {
        refused(save, e);
        noteSettled(save);
        await dropQueuedBefore(save);
      } else {
        noteFailure(save.connectionId, e);
        noteRateLimit(save.connectionId, e);
        await queueSave(save);
      }
      return { saved: null, more: false };
    }
  }).finally(() => {
    if (latestAsked.get(key) === turn) latestAsked.delete(key);
  });
  if (more) void flushReadingQueue();
  return saved;
}

// --- the offline queue -----------------------------------------------------------------------

async function readQueue(): Promise<Claimed<ReadingSave>[]> {
  const queue = await getItem<Claimed<ReadingSave>[]>(READING_QUEUE_KEY);
  return Array.isArray(queue) ? queue : [];
}

/** Every save of a book (`contentKey`) sent one at a time in this tab, the queue's replays
 * included (fe#173): the queue's replays and the open reader's saves (`saveReaderPlace`)
 * once took separate locks, so a replay could be in flight beside a reader's save, both on
 * 0, and the server took them as diverged from each other (a move back kept as the other
 * place). Held over the requests, so in this tab only, and per book: a request that hangs
 * (up to the client's timeout) holds only its own book's saves, never another book's or
 * another server's. A replay takes it per save, not over the whole replay. */
const withSendTurn = keyedSerialQueue();

/** This tab's replays, one at a time (held over the requests, as `progress-sync`'s): a replay
 * asked while one is out waits for it, then sends what is still queued; otherwise it found
 * everything claimed and returned at once, and a sign-out's last-chance flush
 * (`flushReadingConnection`) let the token be revoked under saves still on their way. */
const withReplayTurn = serialQueue();

/** Per book (`contentKey`), the time of the newest save this tab sent and had answered, or
 * had refused for good: a queued save of the book made no later is settled (superseded, or
 * that very save), never sent after it. A replay claims its saves before it sends them, so
 * one it claimed can be overtaken by a reader's save meanwhile. */
const settledUntil = new Map<string, number>();

function noteSettled(save: ReadingSave): void {
  const key = contentKeyOf(save);
  if (timeOf(save) > (settledUntil.get(key) ?? -Infinity)) settledUntil.set(key, timeOf(save));
}

/** Whether `save` is settled in this tab (`settledUntil`). */
const settledHere = (save: ReadingSave) =>
  timeOf(save) <= (settledUntil.get(contentKeyOf(save)) ?? -Infinity);

/** The stored queue's read-modify-writes, in this tab and across tabs (`tabLock`): the tabs
 * of the web player share one queue. Storage only: a replay claims what it sends under it
 * and sends with it released (`replayQueue`), since on plain http it is a lease of a few
 * seconds. */
const withStoredQueue = tabLock(READING_QUEUE_KEY);

/** Queue `save`, the latest per book winning: by the time each was made, not the order the
 * writes come in (another tab's save, or a replay's, written after a newer one of the book
 * never puts the older place back). Whether it was written (`write`, by default best effort:
 * a failure is not told). */
async function queueSave(save: ReadingSave, write = setItem): Promise<boolean> {
  return withStoredQueue(async () => {
    const queue = await readQueue();
    if (queue.some((s) => sameBook(s, save) && timeOf(s) > timeOf(save))) return false;
    const next = queue.filter((s) => !sameBook(s, save));
    next.push(save);
    await write(READING_QUEUE_KEY, next);
    return true;
  });
}

/** Before `save` is sent: an older queued save of its book becomes this one, so the queue
 * never holds a place older than one on its way (closed under the request, the older one was
 * replayed later over it). The lock only when there is one: every page turn sends a save. */
async function queueAhead(save: ReadingSave): Promise<void> {
  const older = (s: ReadingSave) => sameBook(s, save) && timeOf(s) < timeOf(save);
  if ((await readQueue()).some(older)) await queueSave(save);
}

/** Drop a queued save of `sent`'s book made no later than it; whether any save is still
 * queued. The lock only when there is one to drop: every page turn sends a save. */
async function dropQueuedBefore(sent: ReadingSave): Promise<boolean> {
  const stale = (s: ReadingSave) => sameBook(s, sent) && timeOf(s) <= timeOf(sent);
  const queued = await readQueue();
  if (!queued.some(stale)) return queued.length > 0;
  return withStoredQueue(async () => {
    const queue = await readQueue();
    const next = queue.filter((s) => !stale(s));
    if (next.length === queue.length) return next.length > 0;
    try {
      await setItemStrict(READING_QUEUE_KEY, next);
    } catch {
      // Storage refused the drop: the older place is still queued, and a replay would send
      // it after this newer one. Remembered here, so no replay of this tab's does.
      for (const s of queue) if (stale(s)) sentUnsettled.add(queuedKey(s));
      return false;
    }
    return next.length > 0;
  });
}

/** The queued saves this tab must never send (`ReplayQueue.sent`): sent already, or made no
 * later than a save of their book sent since, while storage refused to take them out. */
const sentUnsettled = new Set<string>();

/** Whether `save` is still its book's queued save, as when the replay claimed it. Not once
 * a newer save of the book took its place (the reader's, sent and failed or held), another
 * tab sent a newer one and dropped it, or its connection went. */
async function stillQueued(save: ReadingSave): Promise<boolean> {
  return (await queuedCopy(save)) !== undefined;
}

/** The stored queue's copy of `save` (`queuedKey`: its book and its time), with any claim. */
async function queuedCopy(save: ReadingSave): Promise<Claimed<ReadingSave> | undefined> {
  const key = queuedKey(save);
  return (await readQueue()).find((s) => queuedKey(s) === key);
}

/** The queued saves (`queuedKey`) this tab's replays claimed and are working through
 * (`flushGroup`). A save waiting for its send turn whose copy one of them claimed goes in its
 * own turn, and that replay finds it settled (`settledHere`): left to it, the save went in
 * the replay's order, behind the other books' saves of its connection (each up to the
 * client's timeout), and not at all once one of them stopped the replay. */
const replayingHere = new Set<string>();

/** Whether a save queued as it started to wait for its send turn (`sendThenFlush`) is still
 * queued with no claim of another tab's replay standing on it, so it is this turn's to
 * send. */
async function waitingUnclaimed(save: ReadingSave): Promise<boolean> {
  const copy = await queuedCopy(save);
  return copy !== undefined && (!claimStands(copy) || replayingHere.has(queuedKey(copy)));
}

/** Replay one connection's saves through its client, each in its book's send turn; returns
 * those to keep. A save settled here meanwhile (`settledHere`) is not sent, nor one that left
 * the queue since it was claimed (`stillQueued`): sent after the newer save that replaced or
 * dropped it, in this tab or another, it put the older place back. Such a save is kept, not
 * settled: nothing of it is queued to take out, and a queue that could not be read loses
 * nothing. */
async function flushGroup(
  cid: string,
  client: ApiClient,
  saves: ReadingSave[],
): Promise<ReadingSave[]> {
  const remaining: ReadingSave[] = [];
  const claimed = saves.map(queuedKey);
  for (const key of claimed) replayingHere.add(key);
  // No answer, or the server asked to wait (a 429: later replays wait out its
  // `Retry-After`, `queuedRoute`): the rest of the group waits too.
  let stop = false;
  try {
    for (const save of saves) {
      if (stop) {
        remaining.push(save);
        continue;
      }
      const sent = await withSendTurn(contentKeyOf(save), async () => {
        if (settledHere(save)) return 'settled';
        if (!(await stillQueued(save))) return 'kept';
        try {
          // A save queued as it waited behind its book's own (`sendThenFlush`).
          await put(client, await onOwnVersion(save));
          noteSuccess(cid);
          noteSettled(save);
          return 'settled';
        } catch (e) {
          if (isRefusedForGood(e)) {
            refused(save, e);
            noteSettled(save);
            return 'settled';
          }
          noteFailure(cid, e);
          return stopsReplay(cid, e) ? 'stop' : 'kept';
        }
      });
      if (sent === 'settled') continue;
      remaining.push(save);
      if (sent === 'stop') stop = true;
    }
  } finally {
    for (const key of claimed) replayingHere.delete(key);
  }
  return remaining;
}

/** `replayQueue` over the reader's queue, one replay at a time in this tab: claimed under
 * the stored queue's lock, sent outside it. */
function replayReadingSaves(route: (cid: string) => Route<ApiClient>): Promise<void> {
  return withReplayTurn(() =>
    replayQueue<ReadingSave, ApiClient>({
      lock: withStoredQueue,
      read: readQueue,
      write: (next) => setItemStrict(READING_QUEUE_KEY, next),
      route,
      send: flushGroup,
      sent: sentUnsettled,
    }),
  );
}

/** Replay every queued save through its own connection's client (app open, after a save,
 * the reader opening). Waits for the session, as `progress-sync`'s `flushQueue`. Saves
 * another tab is replaying are left to it. */
export async function flushReadingQueue(): Promise<void> {
  if (!sessionReady()) return;
  await replayReadingSaves(queuedRoute);
}

// A wait the server asked for (a 429) is over: the places it held go now, the reader open
// or not.
onRateLimitOver(() => void flushReadingQueue().catch(() => undefined));

/** Replay one connection's queued saves whatever its recorded reachability or a wait its
 * server asked (`onlyConnection`): it just came back, or it is about to be signed out
 * (`teardownBeforeTokenRevoke`), the queued places' last chance. */
export async function flushReadingConnection(connectionId: string): Promise<void> {
  if (!sessionReady()) return;
  const client = resolveClient(connectionId);
  if (!client) return;
  await replayReadingSaves(onlyConnection(connectionId, client));
}

// --- "Jump there?" -----------------------------------------------------------------------------

/** How far apart two places must be (in the book's progression) to count as different
 * places: a page or two either way is the same place. */
const SAME_PLACE = 0.01;

/** The offer "On {device} you were at {percent}. Jump there?" */
export type JumpOffer = { cfi: string; progression: number; deviceName: string };

/**
 * Whether a save's answer offers a jump: the row the server KEPT is one this device had not
 * seen (another device's, or its own from before its places here were cleared) and is
 * somewhere else than the reader is now (`current`). Jump and Stay acknowledge it
 * (`adoptServerPlace`), so the next save applies; until then this device's saves stay
 * diverged and the server keeps that place. Otherwise (`other_place`, a row it had seen:
 * this save, or its own at a version it acknowledged) nothing is offered.
 */
export function jumpOffer(
  answer: Pick<ReadingSaved, 'saved' | 'seen'>,
  current: { cfi: string; progression: number } | null,
): JumpOffer | null {
  const kept = answer.saved.reading_progress;
  if (!kept || answer.seen) return null;
  if (
    current &&
    (kept.cfi === current.cfi || Math.abs(kept.progression - current.progression) < SAME_PLACE)
  ) {
    return null;
  }
  return { cfi: kept.cfi, progression: kept.progression, deviceName: kept.device_name ?? '' };
}

// Removing a connection (signing out of it too) orphans its reading places, queued saves
// and the app's cached EPUBs.
onConnectionRemoved(async (id) => {
  for (const key of settledUntil.keys()) if (isKeyOf(key, id)) settledUntil.delete(key);
  for (const key of lastCaptured.keys()) if (isKeyOf(key, id)) lastCaptured.delete(key);
  await Promise.all([
    clearEbookCache(id),
    withMirrorLock(async () => {
      const map = await readMirrorMap();
      const kept = Object.fromEntries(
        Object.entries(map).filter(([, entry]) => entry.connectionId !== id),
      );
      if (Object.keys(kept).length !== Object.keys(map).length) {
        await setItem(READING_MIRROR_KEY, kept);
      }
    }),
    withStoredQueue(async () => {
      const queue = await readQueue();
      const next = queue.filter((s) => s.connectionId !== id);
      if (next.length !== queue.length) await setItem(READING_QUEUE_KEY, next);
    }),
  ]);
});
