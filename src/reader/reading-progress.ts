import { ApiError, type ApiClient, isSignedOutError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { isReachable, noteFailure, noteSuccess } from '@/api/reachability';
import type { ReadingProgress, ReadingProgressSaved } from '@/api/types';
import { identityMovePending } from '@/lib/connection-id';
import { contentKey } from '@/lib/content-key';
import { serialQueue } from '@/lib/serial-queue';
import { getItem, setItem } from '@/lib/storage';
import { READING_MIRROR_KEY, READING_QUEUE_KEY } from '@/lib/storage-keys';
import { getDeviceId } from '@/playback/progress-sync';
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
 * from another device made on an older version is DIVERGED, and the server keeps the
 * further of the two places instead of moving the reader back. An answer that kept this
 * device's own place is acknowledged at once (`version` in the mirror); one that kept
 * another device's place only once the open reader has shown it (`adoptServerPlace`: Jump,
 * Stay, or the reader is already there). Until then this device's saves stay diverged, so
 * a place it never saw is never moved back, and after Stay its next save applies: moving
 * back on purpose works. Separate from listening progress on purpose.
 */

/** A place in the book, as the server and the mirror keep it. */
export type ReadingPlace = {
  cfi: string;
  progression: number;
  device_id: string;
  updated_at: string;
};

/** The mirror's record for one book: the newest place this device knows of (by
 * `updated_at`) and the server version it last acknowledged (0 = none). */
type MirrorEntry = {
  connectionId: string;
  libraryId: number;
  path: string;
  place: ReadingPlace | null;
  version: number;
};

/** One save, captured with its `updated_at` and `base_version` so an offline replay says
 * when it was made and what it was made on. */
export type ReadingSave = ReadingPlace & {
  connectionId: string;
  libraryId: number;
  path: string;
  base_version: number;
};

/** A save the server answered: the book it was for and the answer. */
export type ReadingSaved = {
  connectionId: string;
  libraryId: number;
  path: string;
  saved: ReadingProgressSaved;
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

const withMirrorLock = serialQueue();

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

/** Take the server's `row` as seen: its place when newer, and its version. */
const acknowledged =
  (row: ReadingProgress) =>
  (entry: MirrorEntry): MirrorEntry => ({ ...withNewerPlace(row)(entry), version: row.version });

/** Whether the server takes `save` as diverged from its stored `row` (catalog.ResolvePlace):
 * made by another device than the row's, on another version than the row's. */
const diverges = (save: ReadingSave, row: ReadingProgress) =>
  save.base_version !== row.version && save.device_id !== row.device_id;

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
 * the server's row (then the reader adopts it with `adoptServerPlace`). `place` null: none
 * anywhere, open at the start. With no answer from the server, this device's own places
 * stand; with none either, the lookup fails (throws the request's error) instead of
 * opening at the start: a start saved over a place read elsewhere would replace it. A 401
 * always fails it (the token is dead). */
export type ReadingPlaceLookup = {
  place: ReadingPlace | null;
  fromServer: ReadingProgress | null;
};

export async function lookupReadingPlace(
  api: ApiClient | null,
  connectionId: string,
  libraryId: number,
  path: string,
  signal?: AbortSignal,
): Promise<ReadingPlaceLookup> {
  // The local places are read while the server answers.
  const local = Promise.all([readMirror(connectionId, libraryId, path), readQueue()]);
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
  const [mirror, queue] = await local;
  const book = { connectionId, libraryId, path };
  const queued = queue.find((s) => sameBook(s, book)) ?? null;
  let best: ReadingPlace | null = server;
  for (const place of [mirror?.place ?? null, queued]) {
    if (place && (!best || timeOf(place) > timeOf(best))) best = place;
  }
  if (queued && server && diverges(queued, server) && queued.progression > server.progression) {
    best = queued;
  }
  if (!best && unknown !== null) throw unknown;
  return {
    place: best ? placeOf(best) : null,
    fromServer: best !== null && best === server ? server : null,
  };
}

/** The reader has shown the server's `row` (it opened there; or another device's kept place
 * was answered with Jump or Stay, or the reader is already there): this device has seen that
 * version, so its saves are made on it (and the mirror keeps the place). */
export async function adoptServerPlace(
  connectionId: string,
  libraryId: number,
  path: string,
  row: ReadingProgress,
): Promise<void> {
  await updateMirror({ connectionId, libraryId, path }, acknowledged(row));
}

// --- saving ----------------------------------------------------------------------------------

/** A save of `place` now, made on the version this device last acknowledged. */
export async function captureReadingSave(
  connectionId: string,
  libraryId: number,
  path: string,
  place: { cfi: string; progression: number },
): Promise<ReadingSave> {
  const mirror = await readMirror(connectionId, libraryId, path);
  return {
    connectionId,
    libraryId,
    path,
    cfi: place.cfi,
    progression: Math.min(1, Math.max(0, place.progression)),
    device_id: await getDeviceId(),
    updated_at: new Date().toISOString(),
    base_version: mirror?.version ?? 0,
  };
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

const isUnrecoverable = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500;

/** PUT one save, keep the answer's place when newer, tell listeners. Its version is
 * acknowledged when the server kept this device's place; another device's kept place waits
 * for the open reader to show it (`adoptServerPlace`), and no reader may be open: a replay
 * from Home, or the close-save answered after the reader went. */
async function put(client: ApiClient, save: ReadingSave): Promise<ReadingProgressSaved> {
  const saved = await client.saveReadingProgress(save.libraryId, save.path, {
    cfi: save.cfi,
    progression: save.progression,
    device_id: save.device_id,
    updated_at: save.updated_at,
    base_version: save.base_version,
  });
  const row = saved.reading_progress;
  await updateMirror(
    save,
    row.device_id === save.device_id ? acknowledged(row) : withNewerPlace(row),
  );
  const answer = {
    connectionId: save.connectionId,
    libraryId: save.libraryId,
    path: save.path,
    saved,
  };
  for (const listener of savedListeners) listener(answer);
  return saved;
}

/**
 * Save a place now; with no client, an unreachable server or a failed request, queue it
 * for replay (a 4xx is dropped: it can never succeed). The mirror always takes the place
 * first. Resolves the server's answer, or null when it was queued or dropped.
 */
export async function saveReadingPlace(
  api: ApiClient | null,
  save: ReadingSave,
): Promise<ReadingProgressSaved | null> {
  await updateMirror(save, withNewerPlace(save));
  if (!api || !isReachable(save.connectionId)) {
    await enqueue(save);
    return null;
  }
  try {
    const saved = await put(api, save);
    noteSuccess(save.connectionId);
    void flushReadingQueue();
    return saved;
  } catch (e) {
    if (isUnrecoverable(e)) return null;
    noteFailure(save.connectionId, e);
    await enqueue(save);
    return null;
  }
}

// --- the offline queue -----------------------------------------------------------------------

async function readQueue(): Promise<ReadingSave[]> {
  const queue = await getItem<ReadingSave[]>(READING_QUEUE_KEY);
  return Array.isArray(queue) ? queue : [];
}

const withQueueLock = serialQueue();

async function enqueue(save: ReadingSave): Promise<void> {
  await withQueueLock(async () => {
    // The latest save per book wins.
    const next = (await readQueue()).filter((s) => !sameBook(s, save));
    next.push(save);
    await setItem(READING_QUEUE_KEY, next);
  });
}

/** Replay one connection's saves through its client; returns those to keep. */
async function flushGroup(
  cid: string,
  client: ApiClient,
  saves: ReadingSave[],
): Promise<ReadingSave[]> {
  const remaining: ReadingSave[] = [];
  let stop = false;
  for (const save of saves) {
    if (stop) {
      remaining.push(save);
      continue;
    }
    try {
      await put(client, save);
      noteSuccess(cid);
    } catch (e) {
      if (isUnrecoverable(e)) continue;
      noteFailure(cid, e);
      remaining.push(save);
      // An ApiError is this save's own failure; anything else means the server is
      // unreachable, so the rest of the group waits too.
      if (!(e instanceof ApiError)) stop = true;
    }
  }
  return remaining;
}

/** Replay every queued save through its own connection's client (app open, after a save,
 * the reader opening). Waits for the session, as `progress-sync`'s `flushQueue`. */
export async function flushReadingQueue(): Promise<void> {
  if (!sessionReady()) return;
  await withQueueLock(async () => {
    const queue = await readQueue();
    if (queue.length === 0) return;
    const groups = new Map<string, ReadingSave[]>();
    for (const save of queue) {
      const g = groups.get(save.connectionId);
      if (g) g.push(save);
      else groups.set(save.connectionId, [save]);
    }
    const remaining = await Promise.all(
      [...groups].map(async ([cid, saves]) => {
        if (!isReachable(cid)) return saves;
        const client = resolveClient(cid);
        if (!client) return identityMovePending() ? saves : [];
        return flushGroup(cid, client, saves);
      }),
    );
    await setItem(READING_QUEUE_KEY, remaining.flat());
  });
}

/** Replay one connection's queued saves whatever its recorded reachability: it just came
 * back, or it is about to be signed out (`teardownBeforeTokenRevoke`). */
export async function flushReadingConnection(connectionId: string): Promise<void> {
  if (!sessionReady()) return;
  const client = resolveClient(connectionId);
  if (!client) return;
  await withQueueLock(async () => {
    const queue = await readQueue();
    const mine = queue.filter((s) => s.connectionId === connectionId);
    if (mine.length === 0) return;
    const others = queue.filter((s) => s.connectionId !== connectionId);
    const remaining = await flushGroup(connectionId, client, mine);
    await setItem(READING_QUEUE_KEY, [...others, ...remaining]);
  });
}

// --- "Jump there?" -----------------------------------------------------------------------------

/** How far apart two places must be (in the book's progression) to count as different
 * places: a page or two either way is the same place. */
const SAME_PLACE = 0.01;

/** The offer "On {device} you were at {percent}. Jump there?" */
export type JumpOffer = { cfi: string; progression: number; deviceName: string };

/**
 * Whether a save's answer offers a jump: the row the server KEPT is another device's and
 * is somewhere else than the reader is now (`current`). Jump and Stay acknowledge it
 * (`adoptServerPlace`), so the next save applies; until then this device's saves stay
 * diverged and the server keeps that place. Otherwise (`other_place`, this device's own
 * row) nothing is offered.
 */
export function jumpOffer(
  saved: ReadingProgressSaved,
  current: { cfi: string; progression: number } | null,
  deviceId: string,
): JumpOffer | null {
  const kept = saved.reading_progress;
  if (!kept || kept.device_id === deviceId) return null;
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
    withQueueLock(async () => {
      const queue = await readQueue();
      const next = queue.filter((s) => s.connectionId !== id);
      if (next.length !== queue.length) await setItem(READING_QUEUE_KEY, next);
    }),
  ]);
});
