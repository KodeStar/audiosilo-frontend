import { ApiError, type ApiClient } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { isReachable, noteFailure, noteSuccess } from '@/api/reachability';
import type { Progress } from '@/api/types';
import { identityMovePending } from '@/lib/connection-id';
import { contentKey } from '@/lib/content-key';
import { serialQueue } from '@/lib/serial-queue';
import { getItem, setItem } from '@/lib/storage';
import {
  LISTENING_OPEN_SPAN_KEY,
  LISTENING_OUTBOX_KEY,
  PROGRESS_MIRROR_KEY as MIRROR_KEY,
  PROGRESS_QUEUE_KEY as QUEUE_KEY,
} from '@/lib/storage-keys';
import { onConnectionRemoved } from '@/stores/session';

import type { OpenSpan, OutboxEntry } from './listening-outbox';

// Reconnect-driven replay is wired in `provider.tsx`: when a connection recovers it runs
// `flushConnection(cid)`, so a returning server replays exactly its own queued saves.

const DEVICE_KEY = 'audiosilo.deviceId';
// `MIRROR_KEY`: the durable, never-pruned mirror of the last-known progress per
// (connection, library, path). Unlike the offline queue (cleared once a save syncs), this
// survives sync so a returning listener can resume even when the server momentarily can't
// be reached - the fix for "an in-progress book restarted from 0 because the resume fetch
// failed".

let deviceIdCache: string | null = null;

/** Stable per-install device id, sent with progress for last-write-wins. */
export async function getDeviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache;
  let id = await getItem<string>(DEVICE_KEY);
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await setItem(DEVICE_KEY, id);
  }
  deviceIdCache = id;
  return id;
}

/** The device id once `getDeviceId` has read it this launch, else "" (a synchronous read
 * for the web's `pagehide`, which can't wait). */
export function cachedDeviceId(): string {
  return deviceIdCache ?? '';
}

export type ProgressSave = {
  /** Which connection (one user on one server) this save belongs to (never replay it
   * against another). */
  connectionId: string;
  libraryId: number;
  path: string;
  position: number;
  duration: number;
  finished: boolean;
  playback_speed: number;
  device_id: string;
  /** Set at capture time so offline replays reconcile correctly by timestamp. */
  updated_at: string;
  /** The playing audio file (its rel path) and the seconds into it, captured with the
   * whole-book `position`: a resume finds the file in the queue's order and plays from the
   * same place in it, so a place saved on a download's older file order is not read
   * through the new one (fe#188). Mirror only: the legacy PUT never sends it. */
  file?: string;
  file_pos?: number;
  /** Sync v2: the server version of this book's progress this device has acknowledged
   * (`listening-outbox.ts`'s ack rule); a listening span sends it as its `base_version`.
   * Mirror only; kept across captures (`writeMirror`). */
  ack_version?: number;
  /** Sync v2: the other places (`device_id|updated_at`) the listener has answered (Jump or
   * Stay), so an offer never comes back. Mirror only; kept across captures. */
  answered?: string[];
};

/**
 * The outcome of resolving where to resume a book. The three cases are deliberately
 * distinct so the player never confuses "the server says this book is brand new"
 * (start at 0 is correct) with "we couldn't reach the server" (must NOT assume 0):
 *  - `progress`: a saved position exists (from the server, the durable mirror, or the
 *    offline queue, reconciled by `updated_at`).
 *  - `empty`: the server answered (HTTP 200) and there is no record anywhere → new book.
 *  - `failed`: the server was unreachable AND there is no local record → unknown; the
 *    caller must fail safe rather than restart at 0.
 */
export type ResumeLookup =
  | {
      kind: 'progress';
      progress: Progress;
      /** The file place of this device's own save when that save is the newest record: a
       * resume plays that file from `pos` when the queue holds it (fe#188). */
      file?: { path: string; pos: number };
    }
  | { kind: 'empty' }
  | { kind: 'failed' };

/** Newest of two progress records by `updated_at` (last-write-wins, same rule the
 * server uses); ties keep the first argument. */
function timeOf(p: Progress): number {
  const t = Date.parse(p.updated_at);
  return Number.isNaN(t) ? 0 : t;
}
function newest(a: Progress | null, b: Progress | null): Progress | null {
  if (!a) return b;
  if (!b) return a;
  return timeOf(b) > timeOf(a) ? b : a;
}

/** The durable mirror map (keyed by `contentKey`). */
async function readMirrorMap(): Promise<Record<string, ProgressSave>> {
  return (await getItem<Record<string, ProgressSave>>(MIRROR_KEY)) ?? {};
}

/** The offline replay queue. */
async function readQueue(): Promise<ProgressSave[]> {
  return (await getItem<ProgressSave[]>(QUEUE_KEY)) ?? [];
}

/** Sync v2's stored backlog: the outbox's events and the open span, read from storage only
 * (no outbox import: it imports this). Not an array: none; a span with no connection: none. */
async function readListeningBacklog(): Promise<{ outbox: OutboxEntry[]; span: OpenSpan | null }> {
  const [outbox, span] = await Promise.all([
    getItem<OutboxEntry[]>(LISTENING_OUTBOX_KEY),
    getItem<OpenSpan | null>(LISTENING_OPEN_SPAN_KEY),
  ]);
  return {
    outbox: Array.isArray(outbox) ? outbox : [],
    span: span && typeof span.connectionId === 'string' ? span : null,
  };
}

/** What waits to reach a server: the legacy queue's saves, and Sync v2's listens (the
 * outbox's events plus the open span while its server can't be reached), all of them or
 * only `connectionId`'s. */
export async function pendingSaves(
  connectionId?: string,
): Promise<{ saves: number; listens: number }> {
  const [queue, { outbox, span }] = await Promise.all([readQueue(), readListeningBacklog()]);
  const mine = (e: { connectionId?: unknown } | null | undefined) =>
    !!e && (connectionId === undefined || e.connectionId === connectionId);
  const saves = Array.isArray(queue) ? queue.filter(mine).length : 0;
  let listens = outbox.filter(mine).length;
  if (span && mine(span) && !isReachable(span.connectionId)) listens++;
  return { saves, listens };
}

/** How many saves and listens wait to sync (read-only: Home's sync pill), or only
 * `connectionId`'s (the player's sync line: another server's backlog is not this book's). */
export async function pendingSaveCount(connectionId?: string): Promise<number> {
  const { saves, listens } = await pendingSaves(connectionId);
  return saves + listens;
}

export async function loadInitialProgress(
  api: ApiClient | null,
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<ResumeLookup> {
  let serverOk = false;
  let server: Progress | null = null;
  // `api` is null when a downloaded book is played with no live connection (its token
  // failed to hydrate). There's no server to ask, so skip the fetch and resume from the
  // durable mirror / offline queue below - exactly the unreachable-server path.
  if (api) {
    try {
      server = await api.getProgress(libraryId, path); // null = HTTP 200, no record (new book)
      serverOk = true;
    } catch (e) {
      // Reachability is per-connection, so report the failure against THIS book's own
      // server. An `ApiError` is an answer (it is up); anything else only asks for a check
      // (`noteFailure`): one slow read never marks a healthy server down (frontend#131).
      // The local mirror/queue fallback below keys off `serverOk`, not this call.
      if (e instanceof ApiError) noteSuccess(connectionId);
      else noteFailure(connectionId, e);
    }
  }
  // Cache the authoritative server value so a later offline resume has it (keep-newest,
  // so a locally-newer offline advance isn't regressed by a stale server read).
  if (serverOk && server) await writeMirror(progressToSave(connectionId, libraryId, path, server));
  return resumeLookupOf(
    serverOk ? server : undefined,
    await readLocalPlaces(),
    connectionId,
    libraryId,
    path,
  );
}

/** This device's own records of where books are: the durable mirror (by `contentKey`), the
 * offline replay queue, and the books (`contentKey`) with Sync v2 events still waiting to
 * be sent (the outbox's, and the stored open span's). */
export type LocalPlaces = {
  mirror: Record<string, ProgressSave>;
  queue: ProgressSave[];
  pending: Set<string>;
};

/** All three, read at once: for a reader that looks many books up together (the car
 * snapshot's play specs), a few storage reads in all instead of a few per book. */
export async function readLocalPlaces(): Promise<LocalPlaces> {
  const [mirror, queue, { outbox, span }] = await Promise.all([
    readMirrorMap(),
    readQueue(),
    readListeningBacklog(),
  ]);
  const pending = new Set<string>();
  for (const e of outbox) {
    if (typeof e?.connectionId === 'string' && e.event)
      pending.add(contentKey(e.connectionId, e.event.library_id, e.event.path));
  }
  if (span) pending.add(contentKey(span.connectionId, span.libraryId, span.path));
  return { mirror, queue, pending };
}

/**
 * `loadInitialProgress`'s rule, pure: the newest (by `updated_at`) of the server's row, the
 * durable mirror and the offline queue's save. `server` is the server's answer when it was
 * reached (null: no record, a new book there), `undefined` when it was not: only a reached
 * server can make an unknown book `empty`; otherwise it is `failed`.
 */
export function resumeLookupOf(
  server: Progress | null | undefined,
  places: LocalPlaces,
  connectionId: string,
  libraryId: number,
  path: string,
): ResumeLookup {
  const key = contentKey(connectionId, libraryId, path);
  const mirror = places.mirror[key] ?? null;
  const queued =
    places.queue.find(
      (s) => s.connectionId === connectionId && s.libraryId === libraryId && s.path === path,
    ) ?? null;
  const fromMirror = mirrorAsProgress(libraryId, path, mirror);
  const fromQueue = mirrorAsProgress(libraryId, path, queued);
  const newestLocal = newest(newest(server ?? null, fromMirror), fromQueue);
  const best =
    server &&
    newestLocal === fromMirror &&
    serverFinishWins(server, fromMirror, mirror?.ack_version, places.pending.has(key))
      ? server
      : newestLocal;
  if (best) {
    const filed = filePlaceOf(
      best,
      best === server ? null : best === fromQueue ? queued : mirror,
      mirror,
    );
    return {
      kind: 'progress',
      progress: best,
      ...(filed?.file && typeof filed.file_pos === 'number'
        ? { file: { path: filed.file, pos: filed.file_pos } }
        : {}),
    };
  }
  if (server !== undefined) return { kind: 'empty' }; // server reachable + nothing anywhere = truly new
  return { kind: 'failed' }; // never reached the server and no local fallback
}

/**
 * Whether the server's finished row beats this device's newer, unfinished mirror record:
 * the finish is newer than that record, or it is a version this device never acknowledged
 * (another device's finish, landed after this device last saw the row: the mirror's
 * "unfinished" is then only not knowing). A finish is a state the server orders on its
 * own (Sync v2: a listen never unfinishes), so "Listen again" on the finished book starts it
 * again (`unfinish`, then a `restart` span) rather than resuming the old place. Not when
 * this device's own unfinish could still be on its way: its queued save wins as before, and
 * so does its place while the book has events `waiting` to be sent.
 */
function serverFinishWins(
  server: Progress,
  mine: Progress | null,
  ackVersion: number | undefined,
  waiting: boolean,
): boolean {
  if (!mine || waiting || !server.finished || mine.finished) return false;
  const finishedAt = server.finished_at ? Date.parse(server.finished_at) : Number.NaN;
  if (Number.isFinite(finishedAt) && finishedAt > timeOf(mine)) return true;
  return server.version > (ackVersion ?? 0);
}

/** How much older (ms) than a record a file place may be and still be that record's: the
 * server's echo of this device's place is stamped with the span's end in server time,
 * a moment after the capture that took the file place. */
const FILE_PLACE_SLACK_MS = 5_000;

/** Whether two records hold the same place (within a second). */
function samePlace(a: Pick<ProgressSave, 'position'>, b: Pick<ProgressSave, 'position'>): boolean {
  return Math.abs(a.position - b.position) <= 1;
}

type PlaceRecord = Pick<ProgressSave, 'position' | 'device_id' | 'finished' | 'updated_at'>;

/**
 * Whether `record`'s place is the one `filed` holds a file place for: the same place, or a
 * record of the same device in the same finished state that is not newer than `filed` (the
 * server's echo of this device's place, whose seconds the server may have moved to its own
 * file order). Not a place moved since (a Mark not finished, which keeps the device and
 * resets the place): that file place is the book's end. And not a newer record of the same
 * device: `filed` is then older than this device's own last place (writes lost when a
 * browser was killed), and resuming at its file place would move the book back.
 */
function holdsFilePlace(record: PlaceRecord, filed: PlaceRecord): boolean {
  if (samePlace(record, filed)) return true;
  if (!record.device_id || record.device_id !== filed.device_id) return false;
  if (record.finished !== filed.finished) return false;
  const recordAt = Date.parse(record.updated_at);
  const filedAt = Date.parse(filed.updated_at);
  return (
    Number.isFinite(recordAt) &&
    Number.isFinite(filedAt) &&
    filedAt >= recordAt - FILE_PLACE_SLACK_MS
  );
}

/**
 * The record holding the file place (fe#188) for the newest record `best`: its own when it
 * is a save of this device's (`own`), else the mirror's when it holds `best`'s place
 * (`holdsFilePlace`). A place of another device has no file place here: it is that
 * device's, in the server's order.
 */
function filePlaceOf(
  best: Progress,
  own: ProgressSave | null,
  mirror: ProgressSave | null,
): ProgressSave | null {
  if (own?.file) return own;
  if (!mirror?.file) return null;
  return holdsFilePlace(best, mirror) ? mirror : null;
}

/** The durable local mirror for a book, shaped as a `Progress` - for read paths
 * that could not reach the server (an offline book screen), so a downloaded book
 * still reports where the listener is instead of looking untouched. Null when
 * nothing has ever been mirrored for it. */
export async function mirroredProgress(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<Progress | null> {
  return mirrorAsProgress(libraryId, path, await readMirror(connectionId, libraryId, path));
}

/** A stored save (the mirror's, or one waiting in the offline queue) as a `Progress`. */
function mirrorAsProgress(
  libraryId: number,
  path: string,
  save: ProgressSave | null,
): Progress | null {
  return save
    ? {
        library_id: libraryId,
        path,
        position: save.position,
        duration: save.duration,
        finished: save.finished,
        playback_speed: save.playback_speed,
        version: 0,
        device_id: save.device_id,
        updated_at: save.updated_at,
      }
    : null;
}

/** A server's progress row as the save this device keeps for it (the mirror's shape). */
export function progressToSave(
  connectionId: string,
  libraryId: number,
  path: string,
  p: Progress,
): ProgressSave {
  return {
    connectionId,
    libraryId,
    path,
    position: p.position,
    duration: p.duration,
    finished: p.finished,
    playback_speed: p.playback_speed,
    device_id: p.device_id,
    updated_at: p.updated_at,
  };
}

// Serialize mirror read-modify-write so concurrent saves can't clobber each other.
const withMirrorLock = serialQueue();

/** Upsert the durable mirror, keeping the newest record by `updated_at`. The Sync v2
 * fields a capture doesn't carry (`ack_version`, `answered`) are kept from the record it
 * replaces, and so is its file place when the new record holds that place without one (a
 * server row read back after this device's own save: `holdsFilePlace`). */
export async function writeMirror(save: ProgressSave): Promise<void> {
  await withMirrorLock(async () => {
    const map = await readMirrorMap();
    const key = contentKey(save.connectionId, save.libraryId, save.path);
    const existing = map[key];
    if (!existing || Date.parse(save.updated_at) >= Date.parse(existing.updated_at)) {
      map[key] = mergeKept(save, existing);
      await setItem(MIRROR_KEY, map);
    }
  });
}

/** `save` with what the mirror keeps across records (see `writeMirror`). */
function mergeKept(save: ProgressSave, existing: ProgressSave | undefined): ProgressSave {
  if (!existing) return save;
  const out: ProgressSave = { ...save };
  if (out.ack_version === undefined && existing.ack_version !== undefined)
    out.ack_version = existing.ack_version;
  if (out.answered === undefined && existing.answered !== undefined)
    out.answered = existing.answered;
  if (out.file === undefined && existing.file !== undefined && holdsFilePlace(save, existing)) {
    out.file = existing.file;
    out.file_pos = existing.file_pos;
  }
  return out;
}

/**
 * Change a book's mirror record in place (Sync v2: its acknowledged version, the offers
 * answered), creating it from `row` when there is none yet. Nothing when there is neither.
 */
export async function updateMirror(
  connectionId: string,
  libraryId: number,
  path: string,
  change: (save: ProgressSave) => ProgressSave,
  row?: Progress | null,
): Promise<void> {
  await withMirrorLock(async () => {
    const map = await readMirrorMap();
    const key = contentKey(connectionId, libraryId, path);
    const base = map[key] ?? (row ? progressToSave(connectionId, libraryId, path, row) : null);
    if (!base) return;
    const next = change(base);
    if (next === map[key]) return; // unchanged (an acknowledgement already known)
    map[key] = next;
    await setItem(MIRROR_KEY, map);
  });
}

/** Acknowledge `version` of a book's server row (Sync v2): the next span sends it as its
 * `base_version`. Never lowers a known acknowledgement. */
export function ackVersion(
  connectionId: string,
  libraryId: number,
  path: string,
  version: number,
  row?: Progress | null,
): Promise<void> {
  return updateMirror(
    connectionId,
    libraryId,
    path,
    (s) =>
      s.ack_version !== undefined && s.ack_version >= version ? s : { ...s, ack_version: version },
    row,
  );
}

/** At most this many answered offers are kept per book (the newest). */
const MAX_ANSWERED = 20;

/** Answer an offer of another place (Jump, Stay, the book page's "Play from there"): the
 * row's version acknowledged (never lowered) and the offer's `key` (`device_id|updated_at`)
 * noted, the newest `MAX_ANSWERED` kept, in one change of the mirror. */
export function answerOffer(
  connectionId: string,
  libraryId: number,
  path: string,
  row: Progress,
  key: string,
): Promise<void> {
  return updateMirror(
    connectionId,
    libraryId,
    path,
    (s) => {
      const acked = Math.max(s.ack_version ?? row.version, row.version);
      const answered = s.answered?.includes(key)
        ? s.answered
        : [...(s.answered ?? []), key].slice(-MAX_ANSWERED);
      return { ...s, ack_version: acked, answered };
    },
    row,
  );
}

export async function readMirror(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<ProgressSave | null> {
  const map = await readMirrorMap();
  return map[contentKey(connectionId, libraryId, path)] ?? null;
}

function isUnrecoverable(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500;
}

/** Save progress now; if the network fails, queue it for later replay. version
 * is left 0 so the server reconciles by (updated_at, version). */
export async function saveProgress(api: ApiClient, save: ProgressSave): Promise<void> {
  // Reachability is per-connection: this save's success/failure notes ONLY its own
  // server. A book keeps playing on a connection the user has navigated away from, and
  // its 15s save loop lands here without touching any other server's state.
  // Always record the latest position in the durable mirror, independent of the network
  // outcome - this is what a future resume falls back to when the server can't be reached.
  await writeMirror(save);
  // This server known to be unreachable: queue locally without hitting the network, so
  // the 15s save loop doesn't fire a doomed request every tick while it's offline.
  if (!isReachable(save.connectionId)) {
    await enqueue(save);
    return;
  }
  try {
    await api.saveProgress(save.libraryId, save.path, {
      position: save.position,
      duration: save.duration,
      finished: save.finished,
      playback_speed: save.playback_speed,
      version: 0,
      device_id: save.device_id,
      updated_at: save.updated_at,
    });
    noteSuccess(save.connectionId);
    void flushQueue();
  } catch (e) {
    if (isUnrecoverable(e)) return; // auth/forbidden - don't retry forever
    // No answer only asks for a check of the server (`noteFailure`): one slow save never
    // marks a healthy server down; the check does when it gets no answer either.
    noteFailure(save.connectionId, e);
    await enqueue(save);
  }
}

// Serialize all read-modify-write access to the queue so a flush and a
// concurrent save (or two overlapping flushes) can't clobber each other's writes
// and drop queued saves (review finding F4).
const withQueueLock = serialQueue();

async function enqueue(save: ProgressSave): Promise<void> {
  await withQueueLock(async () => {
    const queue = await readQueue();
    // Keep only the latest pending save per (connection, library, path).
    const next = queue.filter(
      (s) =>
        !(
          s.connectionId === save.connectionId &&
          s.libraryId === save.libraryId &&
          s.path === save.path
        ),
    );
    next.push(save);
    await setItem(QUEUE_KEY, next);
  });
}

/**
 * Replay one connection's queued saves in order through its client. Returns the saves
 * that must stay queued (unflushed). Success/failure is noted against THIS connection's
 * own reachability (per-connection banner + probe).
 */
async function flushGroup(
  cid: string,
  client: ApiClient,
  saves: ProgressSave[],
): Promise<ProgressSave[]> {
  const remaining: ProgressSave[] = [];
  // Stop the group only when the server is UNREACHABLE (no point hammering the rest of
  // it); a per-save server error still lets the rest of the group through.
  let stop = false;
  for (const save of saves) {
    if (stop) {
      remaining.push(save);
      continue;
    }
    try {
      await client.saveProgress(save.libraryId, save.path, {
        position: save.position,
        duration: save.duration,
        finished: save.finished,
        playback_speed: save.playback_speed,
        version: 0,
        device_id: save.device_id,
        updated_at: save.updated_at,
      });
      noteSuccess(cid);
    } catch (e) {
      if (isUnrecoverable(e)) continue; // 4xx: drop, can't ever succeed
      noteFailure(cid, e); // only a check marks the server down
      remaining.push(save); // keep it to retry next time
      // An `ApiError` means the server ANSWERED (even a 500), so the failure is specific
      // to this save - keep flushing the rest of the group past it rather than blocking
      // every later book behind one poison entry. A non-`ApiError` is a connection/
      // network failure: the server is unreachable, so stop and retry the group later.
      if (!(e instanceof ApiError)) stop = true;
    }
  }
  return remaining;
}

/**
 * Replay queued saves (call on reconnect / app open / after a successful save). Each
 * entry replays through ITS OWN connection's client, so a save captured on server B
 * can never be written to server A. Grouped by connection preserving order; the
 * groups run concurrently (they touch disjoint servers), so one dead/slow server
 * can't delay every other server's replay by its full timeout.
 */
export async function flushQueue(): Promise<void> {
  // Load-bearing guard: a flush racing session hydrate would resolve every entry's
  // client to null (the connection list is still empty) and drop the whole queue as
  // unroutable. Wait until the session is ready so entries route to a real client.
  if (!sessionReady()) return;
  await withQueueLock(async () => {
    const queue = await readQueue();
    if (queue.length === 0) return;

    // Group by connection, preserving order.
    const groups = new Map<string, ProgressSave[]>();
    for (const save of queue) {
      const g = groups.get(save.connectionId);
      if (g) g.push(save);
      else groups.set(save.connectionId, [save]);
    }

    const remainingByGroup = await Promise.all(
      [...groups].map(async ([cid, saves]) => {
        if (!isReachable(cid)) return saves; // this server known down; keep its saves queued
        const client = resolveClient(cid);
        // A connection removed: unroutable, drop the whole group. Not while an identity
        // move is on its way (`identityMovePending`): the id can be one the documents
        // moved and the connections don't show yet, so the saves wait for that launch.
        if (!client) return identityMovePending() ? saves : [];
        return flushGroup(cid, client, saves);
      }),
    );
    await setItem(QUEUE_KEY, remainingByGroup.flat());
  });
}

/**
 * Flush exactly ONE connection's queued saves through its client, regardless of that
 * connection's recorded reachability. Two callers:
 *  - reconnect (`provider.tsx onReconnect`): the connection just came back, so replay
 *    its backlog immediately;
 *  - teardown (sign-out / remove-connection): its queued saves are about to be purged,
 *    so make a last-chance attempt to land them even if it's marked offline (the server
 *    being removed may itself still be reachable). If it's genuinely unreachable the
 *    attempt fails and the saves stay queued (then get purged - an offline server's
 *    unsynced saves are unrecoverable either way).
 * Unlike `flushQueue`, it does NOT skip on `isReachable(cid)`; it always tries.
 */
export async function flushConnection(connectionId: string): Promise<void> {
  if (!sessionReady()) return;
  const client = resolveClient(connectionId);
  if (!client) return; // already gone - nothing routable to flush
  await withQueueLock(async () => {
    const queue = await readQueue();
    const mine = queue.filter((s) => s.connectionId === connectionId);
    if (mine.length === 0) return;
    const others = queue.filter((s) => s.connectionId !== connectionId);
    const remaining = await flushGroup(connectionId, client, mine);
    await setItem(QUEUE_KEY, [...others, ...remaining]);
  });
}

// Removing a connection orphans its scoped state (signing in again starts from the
// server's own record), so drop its mirror records and queued saves here.
onConnectionRemoved(async (id) => {
  // The mirror and queue take independent locks and touch disjoint storage keys, so
  // purge them concurrently rather than serializing the two storage round-trips.
  await Promise.all([
    withMirrorLock(async () => {
      const map = await readMirrorMap();
      let changed = false;
      for (const [key, save] of Object.entries(map)) {
        if (save.connectionId === id) {
          delete map[key];
          changed = true;
        }
      }
      if (changed) await setItem(MIRROR_KEY, map);
    }),
    withQueueLock(async () => {
      const queue = await readQueue();
      const next = queue.filter((s) => s.connectionId !== id);
      if (next.length !== queue.length) await setItem(QUEUE_KEY, next);
    }),
  ]);
});
