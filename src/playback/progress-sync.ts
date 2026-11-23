import { Platform } from 'react-native';

import { ApiError, type ApiClient, isRefusedForGood, TimeoutError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { liveClient } from '@/api/live-client';
import { onProxyRefusalsOver } from '@/api/proxy-refusal';
import {
  forgetRateLimit,
  noteRateLimit,
  onRateLimitOver,
  rateLimited,
  stopsReplay,
} from '@/api/rate-limit';
import { isReachable, noteFailure, noteSuccess } from '@/api/reachability';
import type { Progress } from '@/api/types';
import { downloadEndsBefore } from '@/downloads/kept-offline';
import {
  identityMovePending,
  resolveConnectionId,
  sameConnection,
  storedConnectionIds,
} from '@/lib/connection-id';
import { contentKey } from '@/lib/content-key';
import { type ClaimCheck, replayQueue, type Route } from '@/lib/queue-claims';
import { serialQueue } from '@/lib/serial-queue';
import { tabChannel, type TabChannel } from '@/lib/tab-channel';
import { tabLock } from '@/lib/tab-lock';
import { getItem, getItemStrict, setItem, setItemStrict } from '@/lib/storage';
import { withTimeout } from '@/lib/with-timeout';
import {
  LISTENING_OPEN_SPAN_KEY,
  LISTENING_OUTBOX_KEY,
  PROGRESS_MIRROR_KEY as MIRROR_KEY,
  PROGRESS_QUEUE_KEY as QUEUE_KEY,
  isRecord,
} from '@/lib/storage-keys';
import { onConnectionRemoved } from '@/stores/session';
import { shallow } from 'zustand/shallow';

import { placeEndsBook } from './book-queue';
import { connectionGeneration } from './connection-generation';
import type { OutboxEntry } from './listening-outbox';
import { type OpenSpan, storedSpans } from './open-span-doc';
import { hasStoredSkews, readStoredSkews } from './stored-skews';
import { type BookRef, bookRefOf } from './types';

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
  /** Taken in a queue that ends before its book does (a download lacking the book's last
   * file, D3, fe#185): its end is not the book's, so a span recovered past it never makes
   * the record finished (`mirrorSpanEnd`). Mirror only; each capture says it again. */
  partial?: true;
  /** Sync v2: the server version of this book's progress this device has acknowledged
   * (`listening-outbox.ts`'s ack rule); a listening span sends it as its `base_version`.
   * Mirror only; kept across captures (`writeMirror`). */
  ack_version?: number;
  /** Sync v2: the other places (`device_id|updated_at`) the listener has answered (Jump or
   * Stay), so an offer never comes back. Mirror only; kept across captures. */
  answered?: string[];
  /** Offer keys whose toast timed out. A held book may offer one again after a play or move. */
  ignored?: string[];
  /** A server's row (`progressToSave`): `updated_at` is by its server's clock, not this
   * device's, and is compared with this device's captures through the known skew
   * (`localTimeOf`, fe#259). Mirror only; a capture never carries it. */
  server_clock?: true;
  /** The legacy PUT path's replay guard (fe#198): a save of a listening session that began
   * from a place this device could not check against its server (an offline start, or a
   * resume behind another device's further place: `ResumeLookup.unchecked`). Before it is
   * PUT, the server's row is read, and another device's further place holds it
   * (`guardHolds`). Saves and the queue only; never kept in the mirror. */
  guard?: boolean;
  /** The listening session a guarded save belongs to (the store's `placeGuard.id`): once
   * one of its saves is PUT, a replay from the queue too, the session's guard is lifted
   * (`guardSettled`). Saves and the queue only. */
  guard_session?: string;
  /** On the record of this device's Mark as finished (`writeFinishedMirror`): the record it
   * replaced, a place (unfinished). Mirror only; never kept across records. */
  before?: ProgressSave;
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
      /** The place was not checked against the server: it was not reached, or its row is
       * further on than the place resumed (another device's, which this device's newer
       * record beat by the clock). The legacy PUT path guards this session's saves
       * (`ProgressSave.guard`, fe#198). */
      unchecked?: true;
    }
  | { kind: 'empty' }
  | { kind: 'failed' };

/** The durable mirror map (keyed by `contentKey`). */
async function readMirrorMap(): Promise<Record<string, ProgressSave>> {
  return (await getItem<Record<string, ProgressSave>>(MIRROR_KEY)) ?? {};
}

/** `readMirrorMap` that rejects when storage could not be read. */
async function readMirrorMapStrict(): Promise<Record<string, ProgressSave>> {
  return (await getItemStrict<Record<string, ProgressSave>>(MIRROR_KEY)) ?? {};
}

/** The offline replay queue. */
async function readQueue(): Promise<ProgressSave[]> {
  return (await getItem<ProgressSave[]>(QUEUE_KEY)) ?? [];
}

/** `readQueue` that rejects when storage could not be read (`ReplayQueue.readStrict`). */
async function readQueueStrict(): Promise<ProgressSave[]> {
  return (await getItemStrict<ProgressSave[]>(QUEUE_KEY)) ?? [];
}

const queueListeners = new Set<() => void>();

/** Store the offline replay queue, read at `before` entries, and tell `onQueueChange`'s
 * listeners when its length changed. A write only ever adds a save, replaces one in place
 * or takes some out, so every count `pendingSaves` gives moves with the length. Rejects
 * when storage refused it (a replay must know: `replayQueue`). */
async function writeQueue(next: ProgressSave[], before: number): Promise<void> {
  await setItemStrict(QUEUE_KEY, next);
  if (next.length !== before) for (const fn of queueListeners) fn();
}

/** Be told when the offline replay queue grew or shrank (a save queued, a replay that
 * drained it): the sync pills read `pendingSaves` again then, not up to 20 s later (fe#197).
 * Returns the unsubscribe. */
export function onQueueChange(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => queueListeners.delete(listener);
}

/** Sync v2's stored backlog: the outbox's events and the open spans (one per web tab
 * playing), read from storage only (no outbox import: it imports this). Not an array: none. */
async function readListeningBacklog(): Promise<{ outbox: OutboxEntry[]; spans: OpenSpan[] }> {
  const [outbox, spans] = await Promise.all([
    getItem<OutboxEntry[]>(LISTENING_OUTBOX_KEY),
    getItem<unknown>(LISTENING_OPEN_SPAN_KEY),
  ]);
  return { outbox: Array.isArray(outbox) ? outbox : [], spans: storedSpans(spans) };
}

/** Each connection's server clock ahead of this device's (ms), as last measured by a sync
 * answer (`noteClockSkew`) or read from its stored copy (`readLocalPlaces`, `knownSkew`). */
const clockSkews = new Map<string, number>();

/** A sync answer measured how far ahead of this device's clock `connectionId`'s server is. */
export function noteClockSkew(connectionId: string, skewMs: number): void {
  if (Number.isFinite(skewMs)) clockSkews.set(connectionId, skewMs);
}

/** The first stored skew read for a connection this launch. Concurrent checks share it. */
const skewLooked = new Map<string, Promise<void>>();

/** `connectionId`'s server clock skew for a merge (ms): this launch's measurement, else the
 * stored one (read once per connection a launch, so the first merge of a launch, before any
 * sync answer, has it too), else 0. */
export async function knownSkew(connectionId: string): Promise<number> {
  if (!clockSkews.has(connectionId) && hasStoredSkews()) {
    let read = skewLooked.get(connectionId);
    if (!read) {
      read = readClockSkews().then(
        () => undefined,
        () => undefined,
      );
      skewLooked.set(connectionId, read);
    }
    await read;
  }
  return clockSkews.get(connectionId) ?? 0;
}

/** Every connection's known server clock skew: the stored ones (through the outbox, their
 * one reader: `stored-skews.ts`, fe#211), this launch's measurements over them. */
async function readClockSkews(): Promise<Record<string, number>> {
  const stored = await readStoredSkews().catch((): Record<string, number> => ({}));
  const out: Record<string, number> = {};
  for (const [cid, skew] of Object.entries(stored)) {
    out[cid] = skew;
    if (!clockSkews.has(cid)) clockSkews.set(cid, skew);
  }
  for (const [cid, skew] of clockSkews) out[cid] = skew;
  return out;
}

/** What waits to reach a server: the legacy queue's saves, and Sync v2's listens (the
 * outbox's `listen` events plus the open spans while their server can't be reached), all of
 * them or only `connectionId`'s (under an id the identity migration moved it from too,
 * `sameConnection`). `events` counts a waiting finish or unfinish too: what removing the
 * connection would drop (`unsentListens`). */
export async function pendingSaves(
  connectionId?: string,
): Promise<{ saves: number; listens: number; events: number }> {
  const [queue, { outbox, spans }] = await Promise.all([readQueue(), readListeningBacklog()]);
  const mine = (e: { connectionId?: unknown } | null | undefined) =>
    !!e &&
    (connectionId === undefined ||
      (typeof e.connectionId === 'string' && sameConnection(e.connectionId, connectionId)));
  const saves = Array.isArray(queue) ? queue.filter(mine).length : 0;
  const waiting = outbox.filter(mine);
  // Listens only: a finish or unfinish waiting is not listening (fe#208).
  const listens = waiting.filter((e) => e.event?.kind === 'listen').length;
  const open = spans.filter((span) => mine(span) && !isReachable(span.connectionId)).length;
  return { saves, listens: listens + open, events: waiting.length + open };
}

/** How many saves and listens wait to sync (read-only: Home's sync pill), or only
 * `connectionId`'s (the player's sync line: another server's backlog is not this book's). */
export async function pendingSaveCount(connectionId?: string): Promise<number> {
  const { saves, listens } = await pendingSaves(connectionId);
  return saves + listens;
}

/** The server's place for a book that started without it (`loadInitialProgress`'s `late`):
 * its row (null: no record there) and this device's mirror record as the start read it,
 * before the session's own saves, which are of the place it started from. */
export type LatePlace = { server: Progress | null; mirror: ProgressSave | null };

/** What `loadInitialProgress` resolves: where the book resumes, and, when the server had not
 * answered within the wait, its answer still to come (`late`). */
export type InitialPlace = ResumeLookup & {
  /** The read that outlasted the wait, going on to the client's own timeout: its answer, or
   * null when it fails. Never rejects. */
  late?: Promise<LatePlace | null>;
};

/** Place reads a start began early (`readPlaceEarly`), by book: the read, when it began, the
 * address it went to and the connection it is of (dropped with it: `onConnectionRemoved`). */
const earlyReads = new Map<
  string,
  { read: Promise<Progress | null>; at: number; baseUrl: string; connectionId: string }
>();
/** How long an early read stays the start's to take (`loadInitialProgress`). */
export const EARLY_READ_MS = 15_000;
/** Whether an early read begun `ageMs` ago may still be taken: within `EARLY_READ_MS`, and
 * never one the device's clock dates in the future (set back since), whose wait would grow. */
const freshEarly = (ageMs: number): boolean => ageMs >= 0 && ageMs <= EARLY_READ_MS;

/**
 * Begin a book's place read now, for the `loadInitialProgress` that follows (a downloaded
 * book's start asks its server for its item and chapters first, `startSourceOf`: the place is
 * read beside that, so a slow server holds the start for one wait, not one wait after the
 * other). That lookup takes it, counting its wait from when the read began; one not taken
 * within `EARLY_READ_MS` is dropped.
 */
export function readPlaceEarly(
  api: ApiClient,
  connectionId: string,
  libraryId: number,
  path: string,
): void {
  const now = Date.now();
  for (const [key, early] of earlyReads) {
    if (!freshEarly(now - early.at)) earlyReads.delete(key);
  }
  const read = api.getProgress(libraryId, path);
  // Never taken (the start was called off), it must not reject unhandled.
  read.catch(() => undefined);
  earlyReads.set(contentKey(connectionId, libraryId, path), {
    read,
    at: now,
    baseUrl: api.baseUrl,
    connectionId,
  });
}

/** The early read of a book (`readPlaceEarly`) made to `api`'s address and still fresh,
 * taken (a second lookup reads afresh), with how long ago it began; else null. */
function takeEarlyRead(
  api: ApiClient,
  key: string,
): { read: Promise<Progress | null>; ageMs: number } | null {
  const early = earlyReads.get(key);
  if (!early) return null;
  earlyReads.delete(key);
  const ageMs = Date.now() - early.at;
  return early.baseUrl === api.baseUrl && freshEarly(ageMs) ? { read: early.read, ageMs } : null;
}

/**
 * Where a book resumes: its server's row (written into the mirror) weighed against this
 * device's own records (`resumeLookupOf`). `waitMs` bounds the wait for the server (a
 * downloaded book, which starts from this device's records when its server is slow: a frozen
 * server held a car's start for the whole request timeout, past the car's own wait). Past it
 * the server is checked (`noteFailure`, as for a read that timed out), the book starts from
 * this device's records, and the read goes on (`late`): a server that answers then is up
 * again (`noteSuccess`, when the connection still uses the address that answered) and its
 * row goes into the mirror; it may hold another device's newer place, which the player then
 * moves to or offers as the place reconcile does (`onLatePlace`). A late read that fails
 * asks for no second check. A read the start began early is taken by a lookup with a wait
 * (`readPlaceEarly`: a downloaded book's start); one with none (Previously on's) reads afresh,
 * leaving it to the start that began it.
 */
export async function loadInitialProgress(
  api: ApiClient | null,
  connectionId: string,
  libraryId: number,
  path: string,
  waitMs?: number,
): Promise<InitialPlace> {
  let serverOk = false;
  let server: Progress | null = null;
  let pending: Promise<Progress | null> | null = null;
  // Reachability is per-connection, so a failure is reported against THIS book's own
  // server. An `ApiError` is an answer (it is up); anything else only asks for a check
  // (`noteFailure`): one slow read never marks a healthy server down (frontend#131).
  const noteError = (e: unknown) => {
    if (e instanceof ApiError) noteSuccess(connectionId);
    else noteFailure(connectionId, e);
  };
  // `api` is null when a downloaded book is played with no live connection (its token
  // failed to hydrate). There's no server to ask, so skip the fetch and resume from the
  // durable mirror / offline queue below - exactly the unreachable-server path.
  if (api) {
    // null = HTTP 200, no record (new book).
    const early =
      waitMs === undefined ? null : takeEarlyRead(api, contentKey(connectionId, libraryId, path));
    const read = early?.read ?? api.getProgress(libraryId, path);
    const wait = waitMs === undefined ? undefined : Math.max(0, waitMs - (early?.ageMs ?? 0));
    // Past the wait: the server is checked as for a read that timed out, and the read goes on.
    const outOfTime = wait === undefined ? null : new TimeoutError(wait);
    try {
      server = outOfTime ? await withTimeout(read, outOfTime.timeoutMs, outOfTime) : await read;
      serverOk = true;
    } catch (e) {
      // The local mirror/queue fallback below keys off `serverOk`, not this call.
      noteError(e);
      if (e === outOfTime) pending = read;
    }
  }
  // Cache the authoritative server value so a later offline resume has it (keep-newest,
  // so a locally-newer offline advance isn't regressed by a stale server read).
  const mirrorRow = (row: Progress) =>
    writeMirror(progressToSave(connectionId, libraryId, path, row));
  if (serverOk && server) await mirrorRow(server);
  const places = await readLocalPlaces();
  const lookup = resumeLookupOf(
    serverOk ? server : undefined,
    places,
    connectionId,
    libraryId,
    path,
  );
  if (!pending) return lookup;
  const mirror = places.mirror[contentKey(connectionId, libraryId, path)] ?? null;
  // The read can answer up to the request's own timeout after it was sent: on an address the
  // connection has left since (a home / away switch), its answer says nothing of the one it
  // uses now (fe#147, as `noteAnswer`).
  const at = api?.baseUrl;
  const answered = () => {
    const now = resolveClient(connectionId);
    if (!now || now.baseUrl === at) noteSuccess(connectionId);
  };
  const late = pending.then(
    async (row): Promise<LatePlace> => {
      // An answer after all: the server is up (the wait had it checked), and its row goes
      // into the mirror as an answer in time does.
      answered();
      if (row) await mirrorRow(row).catch(() => undefined);
      return { server: row, mirror };
    },
    (e: unknown) => {
      // The wait's timeout already had the server checked: a read that then fails the same
      // way asks for no second check. An HTTP answer still says it is up.
      if (e instanceof ApiError) answered();
      return null;
    },
  );
  return { ...lookup, late };
}

/** This device's own records of where books are: the durable mirror (by `contentKey`), the
 * offline replay queue, and the books (`contentKey`) with Sync v2 events still waiting to
 * be sent (the outbox's, and the stored open span's). */
export type LocalPlaces = {
  mirror: Record<string, ProgressSave>;
  queue: ProgressSave[];
  pending: Set<string>;
  /** Each connection's server clock ahead of this device's (ms), where known. */
  skews?: Record<string, number>;
};

/** All three, read at once: for a reader that looks many books up together (the car
 * snapshot's play specs), a few storage reads in all instead of a few per book. */
export async function readLocalPlaces(): Promise<LocalPlaces> {
  const [mirror, queue, { outbox, spans }, skews] = await Promise.all([
    readMirrorMap(),
    readQueue(),
    readListeningBacklog(),
    readClockSkews(),
  ]);
  const pending = new Set<string>();
  for (const e of outbox) {
    if (typeof e?.connectionId === 'string' && e.event)
      pending.add(contentKey(e.connectionId, e.event.library_id, e.event.path));
  }
  for (const span of spans) pending.add(contentKey(span.connectionId, span.libraryId, span.path));
  return { mirror, queue, pending, skews };
}

/** The device's two records, compared before conversion drops the mirror's clock marker.
 * Ties keep the mirror (it can carry the file place and acknowledged version). */
function localRecords(places: LocalPlaces, connectionId: string, libraryId: number, path: string) {
  const key = contentKey(connectionId, libraryId, path);
  const mirror = places.mirror[key] ?? null;
  const queued =
    places.queue.find(
      (s) => s.connectionId === connectionId && s.libraryId === libraryId && s.path === path,
    ) ?? null;
  const skew = places.skews?.[connectionId] ?? 0;
  const local =
    queued && (!mirror || (localTimeOf(queued, skew) || 0) > (localTimeOf(mirror, skew) || 0))
      ? queued
      : mirror;
  return { key, mirror, queued, local, skew };
}

/** The newest of the server's row, mirror and queued save by this device's clock. Ties
 * prefer the server, whose row carries its version. Only a reached server can make an
 * unknown book empty. */
export function resumeLookupOf(
  server: Progress | null | undefined,
  places: LocalPlaces,
  connectionId: string,
  libraryId: number,
  path: string,
): ResumeLookup {
  const { key, mirror, queued, local, skew } = localRecords(places, connectionId, libraryId, path);
  const serverWins =
    server &&
    (!local ||
      (serverTimeOf(server.updated_at, skew) || 0) >= (localTimeOf(local, skew) || 0) ||
      (local === mirror &&
        serverFinishWins(server, local, places.pending.has(key) || !!queued, skew)));
  const best = serverWins ? server : mirrorAsProgress(libraryId, path, local);
  if (best) {
    const filed = filePlaceOf(best, serverWins ? null : local, mirror, skew);
    const unchecked =
      server === undefined ||
      (server !== null &&
        best !== server &&
        !server.finished &&
        server.position - best.position > GUARD_SLACK_S);
    return {
      kind: 'progress',
      progress: best,
      ...(filed?.file && typeof filed.file_pos === 'number'
        ? { file: { path: filed.file, pos: filed.file_pos } }
        : {}),
      ...(unchecked ? { unchecked: true as const } : {}),
    };
  }
  if (server !== undefined) return { kind: 'empty' }; // server reachable + nothing anywhere = truly new
  return { kind: 'failed' }; // never reached the server and no local fallback
}

/**
 * When the place `resumeLookupOf` answered with (over the same `server` and `places`) was
 * saved, by this device's clock (ms, `localTimeOf`): the server's row, or a server's row the
 * mirror holds, moved back by its server's known skew. Undefined with no place (`empty`,
 * `failed`) or an unreadable stamp. Android's car snapshot carries it, so a live place the
 * engine kept is weighed against it (`CarPlaySpec.placeSavedAt`).
 */
export function placeSavedAt(
  lookup: ResumeLookup,
  server: Progress | null | undefined,
  places: LocalPlaces,
  connectionId: string,
  libraryId: number,
  path: string,
): number | undefined {
  if (lookup.kind !== 'progress') return undefined;
  const { local, skew } = localRecords(places, connectionId, libraryId, path);
  const at =
    lookup.progress === server
      ? serverTimeOf(server.updated_at, skew)
      : local
        ? localTimeOf(local, skew)
        : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Whether the server's finished row beats this device's newer, unfinished mirror record:
 * the finish is newer than that record, or it is a version this device never acknowledged
 * (another device's finish, landed after this device last saw the row: the mirror's
 * "unfinished" is then only not knowing). A finish is a state the server orders on its
 * own (Sync v2: a listen never unfinishes), so "Listen again" on the finished book starts it
 * again (`unfinish`, then a `restart` span) rather than resuming the old place. Not when
 * this device's own unfinish could still be on its way: `waiting` while the book has a
 * queued save (a capture writes the mirror and the queue with one `updated_at`, so the tie
 * picks the mirror's record) or Sync v2 events still to be sent.
 */
function serverFinishWins(
  server: Progress,
  mine: ProgressSave,
  waiting: boolean,
  skew: number,
): boolean {
  if (waiting || !server.finished || mine.finished) return false;
  if (server.finished_at && serverTimeOf(server.finished_at, skew) > (localTimeOf(mine, skew) || 0))
    return true;
  return server.version > (mine.ack_version ?? 0);
}

/** How much older (ms) than a record a file place may be and still be that record's: the
 * server's echo of this device's place is stamped with the span's end in server time,
 * a moment after the capture that took the file place. Compared by this device's clock. */
const FILE_PLACE_SLACK_MS = 5_000;

/** Whether two records hold the same place (within a second). */
function samePlace(a: Pick<ProgressSave, 'position'>, b: Pick<ProgressSave, 'position'>): boolean {
  return Math.abs(a.position - b.position) <= 1;
}

type PlaceRecord = Pick<
  ProgressSave,
  'position' | 'device_id' | 'finished' | 'updated_at' | 'server_clock'
>;

/**
 * Whether `record`'s place is the one `filed` holds a file place for: the same place, or a
 * record of the same device in the same finished state that is not newer than `filed` (the
 * server's echo of this device's place, whose seconds the server may have moved to its own
 * file order). Not a place moved since (a Mark not finished, which keeps the device and
 * resets the place): that file place is the book's end. And not a newer record of the same
 * device: `filed` is then older than this device's own last place (writes lost when a
 * browser was killed), and resuming at its file place would move the book back.
 *
 * Either record may be a server row kept in the mirror. Compare them on the same clock
 * so a server ahead keeps a timely file place and a server behind drops a stale one.
 */
function holdsFilePlace(record: PlaceRecord, filed: PlaceRecord, skewMs = 0): boolean {
  if (samePlace(record, filed)) return true;
  if (!record.device_id || record.device_id !== filed.device_id) return false;
  if (record.finished !== filed.finished) return false;
  const recordAt = localTimeOf(record, skewMs);
  const filedAt = localTimeOf(filed, skewMs);
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
  skewMs: number,
): ProgressSave | null {
  if (own?.file) return own;
  if (!mirror?.file) return null;
  return holdsFilePlace(own ?? { ...best, server_clock: true }, mirror, skewMs) ? mirror : null;
}

/** A place as a resume would play it: the record it picks (`resumeLookupOf`), with the
 * file place it plays from when its queue holds that file (fe#188). `file` is this
 * device's own; never on the wire. `server`: the server's own row when the record picked
 * is this device's (`bookPlace`), for what only that row says (its version, its dates,
 * another device's place to offer); this device's records read as version 0. */
export type PlacedProgress = Progress & {
  file?: { path: string; pos: number };
  server?: Progress;
};

/** The server's own row of a place (`PlacedProgress.server`): the place itself when it is
 * that row, or carries none (offline, a book the server has no record of). */
export const serverRowOf = (place: PlacedProgress): Progress => place.server ?? place;

/** `resumeLookupOf`'s pick as a `PlacedProgress`, null when it has none (a new book, or
 * nothing known anywhere). The same object as the record picked when it has no file place. */
function resumePlaceOf(
  server: Progress | null | undefined,
  places: LocalPlaces,
  connectionId: string,
  libraryId: number,
  path: string,
): PlacedProgress | null {
  const lookup = resumeLookupOf(server, places, connectionId, libraryId, path);
  return lookup.kind === 'progress' ? placedOf(lookup) : null;
}

/** A resume lookup's record with its file place; the same object when it has none. */
function placedOf(lookup: Extract<ResumeLookup, { kind: 'progress' }>): PlacedProgress {
  return lookup.file ? { ...lookup.progress, file: lookup.file } : lookup.progress;
}

/**
 * A progress list with each row where Resume would play it (pure; fe#211): this device's
 * own newer record of a book in place of the server's older row (an offline run the list
 * has not heard of yet, a cold launch with another device's kept row), with its file place.
 * Newest first again when any row changed; the same array when none did (or no places).
 */
export function withLocalPlaces<T extends Progress & { connectionId: string }>(
  rows: readonly T[],
  places: LocalPlaces | null,
): readonly (T & PlacedProgress)[] {
  if (!places) return rows;
  let changed = false;
  const out = rows.map((row): T & PlacedProgress => {
    const place = resumePlaceOf(row, places, row.connectionId, row.library_id, row.path);
    if (!place || place === row) return row;
    changed = true;
    return { ...row, ...place };
  });
  return changed ? out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)) : rows;
}

/**
 * Where a book's page shows the listener (fe#211): where Resume would play it from, so the
 * page never shows another device's older row while Resume starts at this device's newer
 * place. `server` is the server's answer when it was reached (null: no record), `undefined`
 * when not (offline: this device's own places, the mirror and the offline queue's save).
 * Null when nothing is known.
 */
export async function bookPlace(
  server: Progress | null | undefined,
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<PlacedProgress | null> {
  const lookup = resumeLookupOf(server, await readLocalPlaces(), connectionId, libraryId, path);
  if (lookup.kind !== 'progress') return null;
  const place = placedOf(lookup);
  // This device's own record says nothing of the server's row (its version, its dates,
  // another device's place to offer): the row goes with it.
  return server && lookup.progress !== server ? { ...place, server } : place;
}

/**
 * A place's whole-book seconds on the timeline `files` lay out (a chapters answer's files),
 * as a resume plays it: at its file place (within that file's length) when `files` holds
 * that file and every file before it has a length, else its own whole-book seconds (pure).
 * After a server reorder, a place this device saved in the download's order then reads
 * where the player would put it.
 */
export function positionOn(
  place: Pick<PlacedProgress, 'position' | 'file'>,
  files: readonly { rel_path: string; duration: number; seq: number }[] | undefined,
): number {
  const file = place.file;
  if (!file || !files?.length) return place.position;
  const ordered = [...files].sort((a, b) => a.seq - b.seq);
  let offset = 0;
  for (const f of ordered) {
    if (f.rel_path === file.path) {
      // Never past the file's end, as a resume lands it (`filePlaceIn`).
      const pos = Math.max(0, file.pos);
      return offset + (f.duration > 0 ? Math.min(pos, f.duration) : pos);
    }
    if (!(f.duration > 0)) return place.position;
    offset += f.duration;
  }
  return place.position;
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
    server_clock: true,
  };
}

/**
 * When a mirror record was written, by this device's clock (ms; NaN when unreadable): a
 * server's row (`server_clock`) moved back by how far its server's clock is ahead of this
 * device's (`skewMs`). The mirror's keep-newest (`writeMirrors`) and a tab's check of the
 * place another tab left (`otherTabsPlace` in the store) compare a capture with a server
 * row through it: with the server's clock S seconds ahead, a server row read back hid this
 * device's own captures for S seconds (fe#259, fe#262).
 */
export function localTimeOf(
  record: Pick<ProgressSave, 'updated_at' | 'server_clock'>,
  skewMs: number,
): number {
  const at = Date.parse(record.updated_at);
  return record.server_clock ? at - skewMs : at;
}

/** A server row's timestamp on this device's clock, like a server row kept in the mirror. */
export function serverTimeOf(updated_at: string, skewMs: number): number {
  return localTimeOf({ updated_at, server_clock: true }, skewMs);
}

/** `localTimeOf` with the record's connection's known skew. */
export async function mirrorTimeOf(record: ProgressSave): Promise<number> {
  return localTimeOf(record, await knownSkew(record.connectionId));
}

/**
 * Whether the mirror's `record` of a book is at least as new as `place`, the place the app
 * has cached for it (`bookPlace`'s pick), by this device's clock (`localTimeOf`). Compared
 * raw, a server's row hid this device's later record (a speed chosen, a finish marked
 * offline) for as long as its server's clock is ahead (fe#259). The same stamp is the same
 * record. Else `place` is read by what it is:
 *  - the server's own row (it has a version, and no `server` row beside it): by its
 *    server's clock;
 *  - a record of this device's with the server's row beside it: by this device's;
 *  - a record read from this device alone (its server not reached, or holding none): the
 *    mirror's or the queue's of then, and the mirror's may have been a server's row, which
 *    the place no longer says. The earlier of the two readings: the mirror only ever takes
 *    a newer record, so its record now is never the older one of those.
 */
export async function mirrorIsNewest(
  record: ProgressSave,
  place: PlacedProgress,
): Promise<boolean> {
  if (record.updated_at === place.updated_at) return true;
  const skew = await knownSkew(record.connectionId);
  const ahead = place.server ? 0 : place.version > 0 ? skew : Math.max(0, skew);
  return localTimeOf(record, skew) >= Date.parse(place.updated_at) - ahead;
}

// The mirror's read-modify-writes one at a time, in this tab and across tabs (`tabLock`): the
// tabs of the web player write one mirror, and a per-tab queue let one tab write its read of
// the whole mirror over another tab's change made meanwhile.
const mirrorLock = tabLock(MIRROR_KEY);

/** One write of records into the mirror (`writeMirrors`); `before`: the record of this
 * device's Mark as finished (`writeFinishedMirror`). */
type MirrorWrite = { save: ProgressSave; before?: true };

/** The writes waiting together for the mirror's lock, until their job starts: a write asked
 * meanwhile joins them, so the writes of one tick (and of a wait for the lock: on plain http
 * a lease, a wait of 30 ms or more each) share one read and one write. */
let waitingWrites: { writes: MirrorWrite[]; done: Promise<void> } | null = null;

/** Any other change of the mirror under its lock: after the writes waiting (none asked after
 * it joins them). */
function withMirrorLock<T>(job: () => Promise<T>): Promise<T> {
  waitingWrites = null;
  return mirrorLock(job);
}

/** Upsert the durable mirror, keeping the newest record by `updated_at` (a server row's by
 * this device's clock: `localTimeOf`). The Sync v2
 * fields a capture doesn't carry (`ack_version`, `answered`) are kept from the record it
 * replaces, and so is its file place when the new record holds that place without one (a
 * server row read back after this device's own save: `holdsFilePlace`). */
export function writeMirror(save: ProgressSave): Promise<void> {
  return writeMirrors([save]);
}

/** `writeMirror` for many records at once: one read and at most one write of the mirror
 * (Home's progress list, fe#198), none when every record is already there as it is (the
 * list read again with no place moved). Writes asked while these wait for the lock join
 * them (`waitingWrites`). */
export function writeMirrors(saves: readonly ProgressSave[]): Promise<void> {
  return queueMirrorWrites(saves.map((save) => ({ save })));
}

/**
 * The record of this device's Mark as finished (`save`, finished): written as `writeMirror`
 * writes, and carrying the record it replaces when that is a place, unfinished (`before`;
 * the same finish written again keeps the place it carried, `placeBeforeFinish`). The
 * Undo of a finish that never reached the server goes back there (`restorePlaceBefore` in
 * the store), deciding by the record it changes under the mirror's lock: a reload, and
 * another tab's finish, see the same record.
 */
export function writeFinishedMirror(save: ProgressSave): Promise<void> {
  return queueMirrorWrites([{ save, before: true }]);
}

/**
 * The place a finish's record carries (`before`) over the record it replaces (`existing`):
 * that record when it is a place, unfinished. Over a finished record, only the place that
 * very finish carried (the same finish written again: its device and stamp): another finish
 * (an earlier Mark, the book finished since and marked again) carries none, or the Undo of
 * this one went back to a place from before that one.
 */
function placeBeforeFinish(save: ProgressSave, existing: ProgressSave): ProgressSave | undefined {
  if (!existing.finished) return existing;
  const same = existing.device_id === save.device_id && existing.updated_at === save.updated_at;
  return same ? existing.before : undefined;
}

function queueMirrorWrites(writes: MirrorWrite[]): Promise<void> {
  if (writes.length === 0) return Promise.resolve();
  if (waitingWrites) {
    waitingWrites.writes.push(...writes);
    return waitingWrites.done;
  }
  const batch = { writes, done: Promise.resolve() };
  waitingWrites = batch;
  batch.done = mirrorLock(() => {
    if (waitingWrites === batch) waitingWrites = null;
    return applyMirrorWrites(batch.writes);
  });
  return batch.done;
}

/** `writeMirrors`' read, merge and write of the mirror. Holding the mirror's lock. */
async function applyMirrorWrites(writes: readonly MirrorWrite[]): Promise<void> {
  const map = await readMirrorMap();
  // Only a finished record can be one an Undo undid (`noteUndoneFinish`), here or in
  // another tab.
  const shared = writes.some((w) => w.save.finished) ? await readUndoneFinishes() : {};
  let changed = false;
  for (const { save, before } of writes) {
    const key = contentKey(save.connectionId, save.libraryId, save.path);
    const existing = map[key];
    const undone = save.finished ? latestUndo(undoneFinishes.get(key), shared[key]) : undefined;
    const skew = existing || undone !== undefined ? await knownSkew(save.connectionId) : 0;
    if (undone !== undefined && undoneBy(key, undone, save, skew)) continue;
    if (!existing || localTimeOf(save, skew) >= localTimeOf(existing, skew)) {
      const { guard: _guard, guard_session: _session, before: _before, ...record } = save;
      const next = mergeKept(record, existing, skew);
      const prior = before && existing && placeBeforeFinish(save, existing);
      if (prior) {
        const { before: _nested, ...place } = prior;
        next.before = place;
      }
      // The same fields (an array kept across records is the same array): no write.
      if (existing && shallow(next, existing)) continue;
      map[key] = next;
      changed = true;
    }
  }
  if (changed) await setItem(MIRROR_KEY, map);
}

/** How long an Undo of a finish holds off its finished record (`noteUndoneFinish`): past a
 * read's 15 s timeout and the write of its answer. */
const UNDONE_FINISH_HOLD_MS = 60_000;
/** The books whose finish was undone here lately (`noteUndoneFinish`), with the time (ms,
 * this device's clock) of each Undo. This launch's, and stored (`UNDONE_FINISHES_KEY`) for
 * the other tabs of the web player. */
const undoneFinishes = new Map<string, number>();
/** The undone finishes every tab of the web player reads (`noteUndoneFinish`), keyed by
 * `contentKey`, each with the time of its Undo: the tabs write one mirror, and another
 * tab's read of the finished row, held off only in the tab that made the Undo, finished it
 * again. Every tab goes by the device's clock. One past the hold is dropped at the next
 * Undo. */
const UNDONE_FINISHES_KEY = 'audiosilo.undoneFinishes';

/** The stored undone finishes (`UNDONE_FINISHES_KEY`); anything else stored there is none. */
async function readUndoneFinishes(): Promise<Record<string, number>> {
  const stored = await getItem<unknown>(UNDONE_FINISHES_KEY);
  const out: Record<string, number> = {};
  if (!isRecord(stored)) return out;
  for (const [key, at] of Object.entries(stored)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[key] = at;
  }
  return out;
}

/** The channel a tab tells the others of a finish it undid on (`tellUndoneElsewhere`). */
const UNDONE_CHANNEL = 'audiosilo-undone-finish';
let undoneTabs: TabChannel<BookRef> | null | undefined;
/** The channel, opened on first use (null off the web). */
const undoneChannel = () =>
  undoneTabs === undefined ? (undoneTabs = tabChannel<BookRef>(UNDONE_CHANNEL)) : undoneTabs;

/** Test-only: the channel `tellUndoneElsewhere` and `onFinishUndoneElsewhere` use. */
export function setUndoneChannelForTests(channel: TabChannel<BookRef> | null | undefined): void {
  undoneTabs = channel;
}

/** Tell the other tabs of the web player that this one undid `ref`'s finish (its Undo, or
 * Mark as not finished), once its mirror record went back: their pages still show the book
 * finished until they read it again. */
export function tellUndoneElsewhere(ref: BookRef): void {
  undoneChannel()?.post(bookRefOf(ref));
}

/** Be told of a finish another tab of the web player undid (`tellUndoneElsewhere`).
 * Returns the unsubscribe. */
export function onFinishUndoneElsewhere(listener: (ref: BookRef) => void): () => void {
  return undoneChannel()?.subscribe(listener) ?? (() => {});
}

/** The later of two Undo times, either unknown. */
function latestUndo(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

// One write of the stored undone finishes at a time, in this tab and across tabs (`tabLock`).
const withUndoneLock = tabLock(UNDONE_FINISHES_KEY);

/**
 * A Mark as finished was undone (`unrecordFinish` in the store): for a while
 * (`UNDONE_FINISH_HOLD_MS`) the mirror takes no finished record of the book stamped before
 * the Undo (by this device's clock, `localTimeOf`). A read of the server's row that was on
 * its way as the Undo was made (the finish's own refresh, fe#272) lands after it with the
 * row for the finish, which the server stamped later than the finished record the Undo
 * replaced: by the newest-wins rule alone it finished the mirror again, and the next
 * offline Play started the book again at 0, until the next read (fe#258). A finish made
 * after the Undo (the end, another device's, Mark as finished again) is stamped after it.
 */
export async function noteUndoneFinish(
  connectionId: string,
  libraryId: number,
  path: string,
  at = Date.now(),
): Promise<void> {
  const current = (when: number) => at - when <= UNDONE_FINISH_HOLD_MS;
  for (const [key, when] of undoneFinishes) {
    if (!current(when)) undoneFinishes.delete(key);
  }
  const key = contentKey(connectionId, libraryId, path);
  undoneFinishes.set(key, at);
  // Held off in the other tabs too: the mirror is theirs as well (web), and one of them may
  // read the finished row after the Undo.
  await withUndoneLock(async () => {
    const stored = await readUndoneFinishes();
    const next: Record<string, number> = { [key]: at };
    for (const [other, when] of Object.entries(stored)) {
      if (other !== key && current(when)) next[other] = when;
    }
    await setItem(UNDONE_FINISHES_KEY, next);
  });
}

/** Whether `save` (a finished record) is one the Undo at `at` of `key`'s finish undid (one
 * stamped before it, while the Undo holds); a hold run out is forgotten. */
function undoneBy(key: string, at: number, save: ProgressSave, skewMs: number): boolean {
  // One dated ahead of now (the clock set back since; a stored one outlives a reload) would
  // hold every finish off until the clock caught up: forgotten too.
  const age = Date.now() - at;
  if (age < 0 || age > UNDONE_FINISH_HOLD_MS) {
    undoneFinishes.delete(key);
    return false;
  }
  return localTimeOf(save, skewMs) < at;
}

/** `save` with what the mirror keeps across records (see `writeMirror`), its server's clock
 * `skewMs` ahead of this device's. */
function mergeKept(
  save: ProgressSave,
  existing: ProgressSave | undefined,
  skewMs: number,
): ProgressSave {
  if (!existing) return save;
  const out: ProgressSave = { ...save };
  if (out.ack_version === undefined && existing.ack_version !== undefined)
    out.ack_version = existing.ack_version;
  if (out.answered === undefined && existing.answered !== undefined)
    out.answered = existing.answered;
  if (out.ignored === undefined && existing.ignored !== undefined) out.ignored = existing.ignored;
  if (
    out.file === undefined &&
    existing.file !== undefined &&
    holdsFilePlace(save, existing, skewMs)
  ) {
    out.file = existing.file;
    out.file_pos = existing.file_pos;
  }
  return out;
}

/**
 * Change a book's mirror record in place (Sync v2: its acknowledged version, the offers
 * answered), creating it from `row` when there is none yet. Nothing when there is neither.
 * A change to null removes the record (a finish that was never queued, on a book with no
 * record before it: `recordFinish` in the store).
 */
export async function updateMirror(
  connectionId: string,
  libraryId: number,
  path: string,
  change: (save: ProgressSave) => ProgressSave | null,
  row?: Progress | null,
): Promise<void> {
  return changeMirror(contentKey(connectionId, libraryId, path), (existing) => {
    const base = existing ?? (row ? progressToSave(connectionId, libraryId, path, row) : null);
    return base ? change(base) : null;
  });
}

function changeMirror(
  key: string,
  change: (existing: ProgressSave | null) => ProgressSave | null,
): Promise<void> {
  return withMirrorLock(async () => {
    const map = await readMirrorMapStrict();
    const existing = map[key] ?? null;
    const next = change(existing);
    if (next === existing) return;
    if (next) map[key] = next;
    else delete map[key];
    await setItem(MIRROR_KEY, map);
  });
}

/**
 * Bring a book's mirror record up to the end of a span a kill left open
 * (`recoverOpenSpan`): the open span is stored every 5 s while the book plays and the
 * mirror every 15 s, so the span's end is this device's later word on the place, and a
 * start with only the mirror to go by (offline, a downloaded book) resumes from it.
 *
 * It is taken as the capture it would have been at the span's last keep, by the mirror's
 * own rule (the newest record wins), and no further:
 * - only a record OLDER than the span's end moves: a place written since stands (the
 *   listener's own move, which saves at once; another tab's play; a server row read since);
 * - only FORWARD: a span ending behind the record never moves a place back;
 * - a finished record stands. A span that says something (`create`: heard, or a move)
 *   supplies the record when none exists yet, never finished: its length is the audio's
 *   (`OpenSpan.duration`), not the book's a save measures the end by (`bookLengthOf`);
 * - never finished at the end of a queue that ends before its book (D3): one the record
 *   was captured in (`partial`), or this device's download of the book when it lacks the
 *   book's last file (`downloadEndsBefore`), unless the span ended in that file (streamed:
 *   its end is the book's); nor while the downloads registry is not read (not known). The
 *   download is asked as well because a server row written into the mirror since the last
 *   capture carries no `partial`.
 * The record becomes this device's, with the span's file place (fe#188) or none.
 */
export async function mirrorSpanEnd(span: OpenSpan, since: number, create: boolean): Promise<void> {
  const { pos, file, filePos } = span.to;
  const endedAt = Date.parse(span.endedAt);
  if (!Number.isFinite(pos) || pos < 0 || !Number.isFinite(endedAt)) return;
  const removed = () => connectionGeneration(span.connectionId) !== since;
  if (removed()) return;
  const [deviceId, shortEnd, skew] = await Promise.all([
    getDeviceId(),
    // Not known (the downloads registry not read): never finished there either (fe#273).
    downloadEndsBefore(span.connectionId, span.libraryId, span.path).then(
      (endsBefore) => endsBefore !== undefined && file !== endsBefore,
      () => true,
    ),
    knownSkew(span.connectionId),
  ]);
  await changeMirror(contentKey(span.connectionId, span.libraryId, span.path), (record) => {
    if (removed() || (!record && !create)) return record;
    if (
      record &&
      (record.finished || pos <= record.position || !(endedAt > localTimeOf(record, skew)))
    )
      return record;
    const { file: _file, file_pos: _filePos, server_clock: _clock, ...kept } = record ?? {};
    const duration = record?.duration ?? (span.duration > 0 ? span.duration : 0);
    return {
      ...bookRefOf(span),
      ...(!record && span.baseVersion !== undefined ? { ack_version: span.baseVersion } : {}),
      ...kept,
      position: pos,
      duration,
      finished: !!record && placeEndsBook(pos, duration, !!record.partial || shortEnd),
      playback_speed: span.speed > 0 ? span.speed : (record?.playback_speed ?? 1),
      device_id: deviceId,
      updated_at: span.endedAt,
      ...(file && Number.isFinite(filePos) ? { file, file_pos: filePos } : {}),
    };
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

/** At most this many answered offers, and as many timed-out ones, are kept per book (the
 * newest). */
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
      return { ...s, ack_version: acked, answered: withKey(s.answered, key) };
    },
    row,
  );
}

/** `keys` with `key` noted (the newest `MAX_ANSWERED` kept). */
function withKey(keys: string[] | undefined, key: string): string[] {
  return keys?.includes(key) ? keys : [...(keys ?? []), key].slice(-MAX_ANSWERED);
}

/** Remember a timed-out offer without acknowledging it. The held-place check may show it
 * again when the listener starts a new play or moves. */
export function ignoreOffer(
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
    (s) =>
      s.answered?.includes(key) || s.ignored?.includes(key)
        ? s
        : { ...s, ignored: withKey(s.ignored, key) },
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

// --- The replay guard (fe#198) ----------------------------------------------------------
//
// The legacy PUT is last-write-wins by `updated_at`, so a save from a session that began at
// a place this device never checked against the server (offline, or behind another
// device's further place) would move that further place back, with no question asked: the
// v2.5.1 sweep saw a place go from 3570 s to 4.78 s. Such a save carries `guard`; before
// a live PUT or replay, the guard checks the server's row. An unanswered place further on
// holds the capture in the queue. The loaded book offers that place through `onHeldSave`.
// The capture goes after an answer or when a fresh check permits it; one still held at the
// final flush before sign-out, checked afresh there, is dropped, never PUT. Sync v2 resolves
// each span on its `base_version`.

/** How much further on (s) another device's place must be to hold a guarded save; the
 * place reconcile's threshold too (`MOVE_THRESHOLD_S`; auto-rewind is up to 30 s). */
export const GUARD_SLACK_S = 30;

/** A place's `answered` key: `device_id|updated_at` (an ISO time has no `|`). */
export function placeKey(p: { device_id?: string; updated_at: string }): string {
  return `${p.device_id}|${p.updated_at}`;
}

/**
 * Whether the server's `row` holds the guarded `save` back (pure): a place of another
 * device, not finished (a finish is not a place to resume; this device's next save
 * unfinishes it, as before), more than `GUARD_SLACK_S` further on, that the listener has not
 * answered (`answered`: the `device_id|updated_at` keys answered with Jump or Stay).
 */
export function guardHolds(
  save: Pick<ProgressSave, 'position' | 'device_id' | 'finished'>,
  row: Progress | null,
  answered: readonly string[] = [],
): boolean {
  if (!row || row.finished || save.finished) return false;
  if (!row.device_id || row.device_id === save.device_id) return false;
  if (row.position - save.position <= GUARD_SLACK_S) return false;
  return !answered.includes(placeKey(row));
}

/** Told of each guarded save held back, with the server's row that held it and this
 * device's mirror record of the book. */
type HeldListener = (save: ProgressSave, row: Progress, mirror: ProgressSave | null) => void;
const heldListeners = new Set<HeldListener>();

/** Be told of each guarded save the server's row held back; returns the unsubscribe. */
export function onHeldSave(listener: HeldListener): () => void {
  heldListeners.add(listener);
  return () => heldListeners.delete(listener);
}

/** Reuse a hold across both the 15 s foreground ticks and the 60 s background ticks.
 * A PUT always needs a fresh check if the guard still applies. */
const HELD_RECHECK_MS = 2 * 60_000;
/** A sign-out's last flush takes only a hold read this recently (ms; the stop's own save
 * just before it): the other device may have gone back below the save since an older one,
 * and the save is dropped if held (`flushGroup`). Read as each save is checked, so a hold
 * read stored while the flush waited its turn is held to it too. */
const LAST_CHANCE_RECHECK_MS = 5_000;
let lastHeld: { session: string; connectionId: string; row: Progress; at: number } | null = null;

/** Whether `save` may be PUT. Tell the player even on a cached hold so a fresh play or move
 * can offer that place again. An answered or nearly reached place is checked afresh before
 * a PUT, since the other device may have moved further meanwhile. */
async function guardPasses(
  client: ApiClient,
  save: ProgressSave,
  current: () => boolean,
  reuseMs = HELD_RECHECK_MS,
): Promise<boolean> {
  if (!save.guard) return true;
  const now = Date.now();
  const cached = lastHeld;
  const reusable =
    cached &&
    cached.session === save.guard_session &&
    cached.connectionId === save.connectionId &&
    cached.row.library_id === save.libraryId &&
    cached.row.path === save.path &&
    now >= cached.at &&
    now - cached.at < reuseMs
      ? cached.row
      : null;
  // Only a cached hold needs the mirror's answer before deciding; otherwise the mirror and
  // the server's row are read together.
  let mine: ProgressSave | null = null;
  let row: Progress | null = null;
  if (reusable) {
    mine = await readMirror(save.connectionId, save.libraryId, save.path);
    if (!current()) return false;
    if (guardHolds(save, reusable, mine?.answered)) row = reusable;
  }
  if (!row) {
    let fresh: Progress | null;
    if (reusable) fresh = await client.getProgress(save.libraryId, save.path);
    else
      [mine, fresh] = await Promise.all([
        readMirror(save.connectionId, save.libraryId, save.path),
        client.getProgress(save.libraryId, save.path),
      ]);
    if (!current()) return false;
    if (!fresh || !guardHolds(save, fresh, mine?.answered)) return true;
    row = fresh;
    noteSuccess(save.connectionId);
    if (save.guard_session) {
      lastHeld = { session: save.guard_session, connectionId: save.connectionId, row, at: now };
    }
  }
  for (const listener of heldListeners) {
    try {
      listener(save, row, mine);
    } catch {
      // A listener's failure never turns a held save into a failed one (queued, retried).
    }
  }
  return false;
}

/** Sessions (`ProgressSave.guard_session`) one of whose guarded saves was PUT, the newest
 * `MAX_SETTLED_GUARDS` (only the live session's is ever asked; a queue replays a few older
 * ones). */
const settledGuards = new Set<string>();
const MAX_SETTLED_GUARDS = 50;

/** Whether a guarded save of `session` has been PUT (live or replayed from the queue): the
 * server had nothing further on, so the session's later saves need no read first. */
export function guardSettled(session: string): boolean {
  return settledGuards.has(session);
}

/** A save was PUT: its session's guard, if any, is settled. */
function notePut(save: ProgressSave): void {
  if (!save.guard || !save.guard_session) return;
  settledGuards.delete(save.guard_session); // re-added as the newest
  settledGuards.add(save.guard_session);
  for (const old of settledGuards) {
    if (settledGuards.size <= MAX_SETTLED_GUARDS) break;
    settledGuards.delete(old);
  }
}

/** What became of a save: PUT (`saved`), kept for a later replay (`queued`), held back by
 * the replay guard (`held`), or refused for good (`dropped`, a 4xx but a 408 or a 429). */
export type SaveOutcome = 'saved' | 'queued' | 'held' | 'dropped';

/** Send a live or replayed capture only through its own sign-in. A guard read can outlast
 * account removal, as can the PUT itself. A guarded save is always checked first, also at a
 * sign-out's last flush: a held one is never PUT (`flushGroup`). */
async function putSave(
  client: ApiClient,
  save: ProgressSave,
  current: () => boolean,
  reuseMs?: number,
): Promise<'held' | 'saved' | 'dropped'> {
  const allowed = await guardPasses(client, save, current, reuseMs);
  if (!current()) return 'dropped';
  if (!allowed) return 'held';
  await client.saveProgress(save.libraryId, save.path, putBody(save));
  if (!current()) return 'dropped';
  notePut(save);
  noteSuccess(save.connectionId);
  return 'saved';
}

/** Save progress now; if the network fails, queue it for later replay. version
 * is left 0 so the server reconciles by (updated_at, version). A guarded save is checked
 * first (`guardPasses`). Sent through the save's connection as it is at each request
 * (`liveClient`; `api` only when it is not signed in now): a re-pair while the mirror was
 * written or the guard read changed the token, and the old one is refused (401). */
export async function saveProgress(
  api: ApiClient,
  save: ProgressSave,
  { requireQueued = false }: { requireQueued?: boolean } = {},
): Promise<SaveOutcome> {
  // Reachability is per-connection: this save's success/failure notes ONLY its own
  // server. A book keeps playing on a connection the user has navigated away from, and
  // its periodic save loop lands here without touching any other server's state.
  // Always record the latest position in the durable mirror, independent of the network
  // outcome - this is what a future resume falls back to when the server can't be reached.
  const since = connectionGeneration(save.connectionId);
  const current = () => connectionGeneration(save.connectionId) === since;
  await writeMirror(save);
  if (!current()) return 'dropped';
  // This server known to be unreachable, or one that asked to wait (a 429 until its
  // `Retry-After`, `rateLimited`): queue locally without hitting the network, so the
  // periodic save loop doesn't fire a doomed request every tick. The queue's replay sends
  // it once the server is back or the wait is over (`onRateLimitOver`).
  let outcome: SaveOutcome = 'queued';
  if (isReachable(save.connectionId) && !rateLimited(save.connectionId)) {
    const client = liveClient(save.connectionId) ?? api;
    try {
      outcome = await putSave(client, save, current);
    } catch (e) {
      if (!current() || isRefusedForGood(e)) return 'dropped';
      noteFailure(save.connectionId, e);
      noteRateLimit(save.connectionId, e);
    }
  }
  // A rollback removes its source events only after a successful send or durable transfer.
  // Live saves still have the mirror if storage has no room for the queue.
  if (!current() || outcome === 'dropped') return 'dropped';
  const queued = updateQueuedSave(save, outcome === 'saved', current);
  if (requireQueued && outcome !== 'saved') await queued;
  else await queued.catch(() => undefined);
  if (!current()) return 'dropped';
  if (outcome === 'saved') void flushQueue();
  return outcome;
}

/** A save as the legacy PUT's body. */
function putBody(save: ProgressSave) {
  return {
    position: save.position,
    duration: save.duration,
    finished: save.finished,
    playback_speed: save.playback_speed,
    version: 0,
    device_id: save.device_id,
    updated_at: save.updated_at,
  };
}

// The queue's read-modify-writes one at a time, in this tab and across tabs (`tabLock`): the
// tabs of the web player share one queue, and a lock per tab let one tab's replay write
// its read of the queue over a save another tab queued meanwhile. Storage only: a replay
// sends outside it (`replayQueue`), since on plain http the lock is a lease of a few
// seconds and a replay can take longer.
const withQueueLock = tabLock(QUEUE_KEY);

/** Keep the latest capture of a book. A successful live PUT retires its older queued save
 * too, including a held save the listener has since answered with Jump or Stay. */
async function updateQueuedSave(
  save: ProgressSave,
  sent: boolean,
  current: () => boolean,
): Promise<void> {
  const sameBook = (s: ProgressSave) =>
    sameConnection(s.connectionId, save.connectionId) &&
    s.libraryId === save.libraryId &&
    s.path === save.path;
  // A sent save with nothing of its book queued (nearly every live tick) has nothing to
  // retire: skip the cross-tab lock.
  if (sent && !(await readQueue()).some(sameBook)) return;
  await withQueueLock(async () => {
    // The purge uses this lock too. It either runs after this write or has already
    // invalidated the sign-in that requested it.
    if (!current()) return;
    const queue = await readQueueStrict();
    // An earlier guard read can finish after a newer save queued.
    const newer = (s: ProgressSave) => Date.parse(s.updated_at) > Date.parse(save.updated_at);
    const next = queue.filter((s) => !sameBook(s) || newer(s));
    if (!sent && !next.some(sameBook)) next.push(save);
    else if (next.length === queue.length) return;
    await writeQueue(next, queue.length);
  });
}

/**
 * Replay one connection's queued saves in order through its client. Returns the saves
 * that must stay queued (unflushed). Success/failure is noted against THIS connection's
 * own reachability (per-connection banner + probe). Each request goes through the
 * connection as it is when it is sent (`liveClient`; the route's `routed` client only when
 * it is not signed in now, a sign-out's last flush): a re-pair during the replay changes
 * the token, and the saves after it would go with the old one and be refused (401).
 */
async function flushGroup(
  cid: string,
  routed: ApiClient,
  saves: ProgressSave[],
  mine: ClaimCheck<ProgressSave>,
  lastChance: boolean,
): Promise<ProgressSave[]> {
  const since = connectionGeneration(cid);
  const current = () => connectionGeneration(cid) === since;
  const client = liveClient(cid) ?? routed;
  const remaining: ProgressSave[] = [];
  // Stop the group only when the server is UNREACHABLE (no point hammering the rest of
  // it) or asked to wait (a 429: later replays wait out its `Retry-After`, `queuedRoute`); a
  // per-save server error still lets the rest of the group through.
  let stop = false;
  for (const save of saves) {
    if (stop) {
      remaining.push(save);
      continue;
    }
    // Another replay claimed it since (this tab's timers throttled while it sent those
    // ahead, or a sign-out took it over), or it left the queue: not this replay's to send.
    if (!(await mine(save))) {
      remaining.push(save);
      continue;
    }
    try {
      // Held: it waits in the queue for the listener's answer to the offer. Not at a
      // sign-out's last flush: unanswered, it is dropped with the mirror, never PUT. The
      // legacy PUT is last-write-wins by `updated_at`, so it would move the other device's
      // further place back (fe#198). Sync v2 never queues one here: its listens reach the
      // server as events, which the server resolves against that place.
      // Checked on a fresh read then, unless the stop's own save just read it.
      const reuseMs = lastChance ? LAST_CHANCE_RECHECK_MS : undefined;
      const outcome = await putSave(client, save, current, reuseMs);
      if (outcome === 'held' && !lastChance) remaining.push(save);
    } catch (e) {
      if (!current() || isRefusedForGood(e)) continue;
      noteFailure(cid, e); // only a check marks the server down
      remaining.push(save); // keep it to retry next time
      // A save's own failure lets the rest through, so one poison entry never blocks every
      // later book; no answer or a 429 stops the group (fe#173).
      if (stopsReplay(cid, e)) stop = true;
    }
  }
  return remaining;
}

/** This tab's replays of the legacy queue, one at a time (held over the requests, so in this
 * tab only): a replay asked while one is out waits for it, then sends what is still queued.
 * Without it, it found everything claimed and returned at once: a sign-out's last-chance
 * flush (`flushConnection`) let the token be revoked under the saves still on their way,
 * and a reconnect's left the saves of a replay that then failed queued until the next save. */
const withReplayTurn = serialQueue();

/** The saves this tab sent whose removal from the queue storage refused
 * (`ReplayQueue.sent`). */
const sentUnsettled = new Set<string>();

/** `replayQueue` over the legacy queue: claimed under its lock, sent outside it.
 * `takeOver`: a sign-out's last send (`ReplayQueue.takeOver`). */
function replaySaves(
  route: (cid: string) => Route<ApiClient> | Promise<Route<ApiClient>>,
  takeOver = false,
): Promise<void> {
  return withReplayTurn(() =>
    replayQueue<ProgressSave, ApiClient>({
      lock: withQueueLock,
      read: readQueue,
      readStrict: readQueueStrict,
      write: writeQueue,
      route,
      send: (cid, client, saves, mine) => flushGroup(cid, client, saves, mine, takeOver),
      sent: sentUnsettled,
      takeOver,
    }),
  );
}

/**
 * Replay queued saves (call on reconnect / app open / after a successful save). Each
 * entry replays through ITS OWN connection's client, so a save captured on server B
 * can never be written to server A. Grouped by connection preserving order; the
 * groups run concurrently (they touch disjoint servers), so one dead/slow server
 * can't delay every other server's replay by its full timeout. Saves another tab is
 * replaying are left to it (`replayQueue`), and so are a connection this tab does not know
 * (`storedRoute`). `connectionId`: that connection's alone (`routeOnly`).
 */
export async function flushQueue(connectionId?: string): Promise<void> {
  // Load-bearing guard: a flush racing session hydrate would resolve every entry's
  // client to null (the connection list is still empty) and drop the whole queue as
  // unroutable. Wait until the session is ready so entries route to a real client.
  if (!sessionReady()) return;
  await replaySaves(
    connectionId === undefined ? storedRoute : routeOnly(connectionId, storedRoute),
  );
}

// A wait the server asked for (a 429) is over, or a proxy's refusals of the connection ended
// (`onProxyRefusalsOver`): the saves they held go now, not at the next replay. That
// connection's only: another's are held by their own wait, or went already.
const sendHeld = (connectionId: string) => void flushQueue(connectionId).catch(() => undefined);
onRateLimitOver(sendHeld);
onProxyRefusalsOver(sendHeld);

/** Where a replay of a stored queue (this one, the reader's) sends a connection's saves:
 * through its client, kept while its server is known down or asked to wait (a 429 until its
 * `Retry-After`, `rateLimited`), dropped with the connection. */
export function queuedRoute(cid: string): Route<ApiClient> {
  if (!isReachable(cid)) return 'keep'; // this server known down; keep its saves queued
  if (rateLimited(cid)) return 'keep'; // the server asked to wait; replayed once it is over
  const client = resolveClient(cid);
  // A connection removed: unroutable, drop the whole group. Not while an identity
  // move is on its way (`identityMovePending`): the id can be one the documents
  // moved and the connections don't show yet, so the saves wait for that launch.
  if (!client) return identityMovePending() ? 'keep' : 'drop';
  return { send: client };
}

/**
 * `queuedRoute` for a replay of every connection's queued saves (this queue, the reader's, the
 * waiting bookmarks), except that on the web a connection this tab's session does not know
 * is dropped only once it is gone from the stored connections too: one signed in to in
 * another tab since this tab loaded is that tab's to replay (its saves, a live one waiting
 * for its turn included; one naming the id the identity migration moved it from too), and
 * storage that could not be read knows of no connection gone.
 * Off the web there is no other tab: the session is every connection there is.
 */
export async function storedRoute(cid: string): Promise<Route<ApiClient>> {
  const route = queuedRoute(cid);
  if (route !== 'drop' || Platform.OS !== 'web') return route;
  const stored = await storedConnectionIds();
  // Under the id the save names, or the one the identity migration moved it to.
  if (stored === null || stored.has(cid) || stored.has(resolveConnectionId(cid))) return 'keep';
  return 'drop';
}

/** `route` for `connectionId`'s saves alone (whichever of its ids they name,
 * `resolveConnectionId`): the rest stay. */
export const routeOnly =
  <R>(connectionId: string, route: (cid: string) => R) =>
  (cid: string): R | 'keep' =>
    sameConnection(cid, connectionId) ? route(cid) : 'keep';

/** A replay's route of `connectionId`'s saves alone (`routeOnly`: whichever of its ids they
 * name), through `client`: the rest stay. Whatever a wait its server asked (`rateLimited`): a
 * sign-out's last chance tries them. */
export const onlyConnection = (
  connectionId: string,
  client: ApiClient,
): ((cid: string) => Route<ApiClient>) => routeOnly(connectionId, () => ({ send: client }));

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
 * Unlike `flushQueue`, it does NOT skip on `isReachable(cid)`; it always tries. A last
 * chance (`lastChance`) also waits for another tab's claim on them, then takes over what is
 * left (`ReplayQueue.takeOver`, the web's): signed out here, they were purged unsent.
 */
export async function flushConnection(
  connectionId: string,
  opts: { lastChance?: boolean } = {},
): Promise<void> {
  if (!sessionReady()) return;
  const client = resolveClient(connectionId);
  if (!client) return; // already gone - nothing routable to flush
  await replaySaves(onlyConnection(connectionId, client), opts.lastChance === true);
}

// Removing a connection orphans its scoped state (signing in again starts from the
// server's own record), so drop its mirror records and queued saves here.
onConnectionRemoved(async (id) => {
  if (lastHeld && sameConnection(lastHeld.connectionId, id)) lastHeld = null;
  clockSkews.delete(id);
  skewLooked.delete(id);
  forgetRateLimit(id);
  // An early place read of its books is never taken by a start made once it is signed in
  // again (a connection with no user id keeps its id for whoever signs in next).
  for (const [key, early] of earlyReads) {
    if (early.connectionId === id) earlyReads.delete(key);
  }
  // The mirror and queue take independent locks and touch disjoint storage keys, so
  // purge them concurrently rather than serializing the two storage round-trips.
  await Promise.all([
    withMirrorLock(async () => {
      const map = await readMirrorMap();
      let changed = false;
      for (const [key, save] of Object.entries(map)) {
        if (sameConnection(save.connectionId, id)) {
          delete map[key];
          changed = true;
        }
      }
      if (changed) await setItem(MIRROR_KEY, map);
    }),
    withQueueLock(async () => {
      const queue = await readQueue();
      // Under an id the identity migration moved it from too, as its last send and
      // `pendingSaves` take them.
      const next = queue.filter((s) => !sameConnection(s.connectionId, id));
      if (next.length !== queue.length) {
        await writeQueue(next, queue.length).catch(() => undefined);
      }
    }),
  ]);
});
