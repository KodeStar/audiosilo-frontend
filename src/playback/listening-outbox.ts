import { ApiError, type ApiClient } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { cachedCapability, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { isReachable, noteFailure, noteSuccess } from '@/api/reachability';
import type {
  ListeningEvent,
  ListeningFinishEvent,
  ListeningSpanEvent,
  ListeningStart,
  ListeningSyncResponse,
  ListeningSyncResult,
  Progress,
} from '@/api/types';
import { randomUUID } from '@/lib/random';
import { serialQueue } from '@/lib/serial-queue';
import { getItem, getItemStrict, setItem } from '@/lib/storage';
import {
  isRecord,
  LISTENING_OPEN_SPAN_KEY as OPEN_SPAN_KEY,
  LISTENING_OUTBOX_KEY as OUTBOX_KEY,
  LISTENING_SYNC_KEY as SYNC_KEY,
} from '@/lib/storage-keys';
import { onConnectionRemoved } from '@/stores/session';

import {
  ackVersion,
  getDeviceId,
  pendingSaves,
  type ProgressSave,
  readMirror,
  saveProgress,
} from './progress-sync';

/**
 * Sync v2's listening outbox (Track W1, CROSS-REPO section 25): on a server with
 * `listening_sync`, the player records listening as events instead of saving a place. A
 * span of playing is one `listen` event (whole-book seconds on this device's timeline, plus
 * each end's audio file and in-file seconds, fe#188), and marking the book finished or not is
 * a `finish`/`unfinish`. Events wait here, append-only, until their server answers for them
 * (`POST /me/listening/sync`); the server resolves each against the stored place by its
 * `base_version` (this device's acknowledged version), so an old offline span never moves a
 * further place back.
 *
 * - `audiosilo.listeningOutbox`: the closed events, each with its `connectionId`. An event is
 *   immutable once it is here (the store closes spans into new ones; nothing merges).
 * - `audiosilo.listeningOpenSpan`: the one span being played, rewritten each offline tick,
 *   so a span a kill left open is closed at its last stored values on the next launch
 *   (`recoverOpenSpan`).
 * - `audiosilo.listeningSync`: per connection, when it last synced and the events the server
 *   rejected (the "couldn't sync" list, kept 30 days or until discarded).
 *
 * Sending (`flushOutbox`): one request in flight per connection, chunks of 200 events, the
 * device clock (`sent_at`) set per attempt. Every status but `rejected` removes the event;
 * `rejected` moves it to the couldn't-sync list. A network error or 5xx keeps everything; a
 * 413 or `too_many_events` halves the chunk; a 400 on a batch sends its events one by one
 * once, and one still refused alone is moved to the list. A 404/405 that the server's own
 * `/server` confirms (no `listening_sync`) means it was rolled back to one without the route:
 * the connection's outbox becomes one legacy save per book (`legacySavesOf`) and the player
 * saves by PUT from then on (`usesListeningSync`).
 */

/** One end of a span: whole-book seconds, and the audio file (rel path) and seconds in it. */
export type SpanEnd = { pos: number; file?: string; filePos?: number };

/** A span being played (store.ts keeps it in memory and here while offline). */
export type OpenSpan = {
  connectionId: string;
  libraryId: number;
  path: string;
  from: SpanEnd;
  to: SpanEnd;
  /** The device's length of the book (0 = unknown). */
  duration: number;
  speed: number;
  /** ISO, device clock. */
  startedAt: string;
  endedAt: string;
  start: ListeningStart;
  /** The version acknowledged when the span opened (absent: none known, last write wins). */
  baseVersion?: number;
};

/** An event waiting for its server. */
export type OutboxEntry = { connectionId: string; event: ListeningEvent };

/** An event its server rejected, kept to show (the account's couldn't-sync list). */
export type CouldNotSync = { event: ListeningEvent; reason: string; at: string };

/** What the account card shows of one connection's sync. */
export type ConnectionSyncState = { lastSyncAt?: string; failed?: CouldNotSync[] };

/** At most this many events per request (the server takes 500). */
const MAX_CHUNK = 200;
/** The web's `pagehide` sends at most this much in its keepalive request (64 KB limit). */
const KEEPALIVE_BYTES = 60_000;
/** A rejected event stays on the couldn't-sync list this long. */
export const COULD_NOT_SYNC_KEEP_MS = 30 * 24 * 60 * 60_000;
/** At most this many (the newest) per connection: a book the server keeps refusing adds
 * one each 15 s cut while it plays. */
export const MAX_COULD_NOT_SYNC = 100;
/** A span shorter than this that moved nowhere says nothing (a play stopped at once). */
const EMPTY_SPAN_MS = 1_000;

// --- Building events -------------------------------------------------------------------

/** A new event id (a UUID: the server takes 1-64 of `[A-Za-z0-9_-]`). */
const newEventId = (): string => randomUUID();

/** A span as its `listen` event (pure). Each end's file pair is sent only whole. */
export function spanToEvent(span: OpenSpan, id: string = newEventId()): ListeningSpanEvent {
  const event: ListeningSpanEvent = {
    id,
    kind: 'listen',
    library_id: span.libraryId,
    path: span.path,
    from_pos: Math.max(0, span.from.pos),
    to_pos: Math.max(0, span.to.pos),
    started_at: span.startedAt,
    ended_at: span.endedAt < span.startedAt ? span.startedAt : span.endedAt,
    start: span.start,
  };
  if (span.from.file && isPos(span.from.filePos)) {
    event.from_file = span.from.file;
    event.from_file_pos = Math.max(0, span.from.filePos);
  }
  if (span.to.file && isPos(span.to.filePos)) {
    event.to_file = span.to.file;
    event.to_file_pos = Math.max(0, span.to.filePos);
  }
  if (span.duration > 0) event.duration = span.duration;
  if (span.speed > 0 && span.speed <= 4 && span.speed !== 1) event.playback_speed = span.speed;
  if (span.baseVersion !== undefined) event.base_version = span.baseVersion;
  return event;
}

const isPos = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** Whether a span carries anything: listening, or a deliberate move (pure). */
export function spanSaysSomething(span: OpenSpan): boolean {
  const ms = Date.parse(span.endedAt) - Date.parse(span.startedAt);
  if (ms >= EMPTY_SPAN_MS || Math.abs(span.to.pos - span.from.pos) >= 1) return true;
  return span.start === 'jump' || span.start === 'moved_back' || span.start === 'restart';
}

/** A `finish` or `unfinish` event at `at` (ISO). */
export function finishEvent(
  kind: 'finish' | 'unfinish',
  ref: { libraryId: number; path: string },
  at: string,
  baseVersion?: number,
): ListeningFinishEvent {
  return {
    id: newEventId(),
    kind,
    library_id: ref.libraryId,
    path: ref.path,
    at,
    ...(baseVersion !== undefined ? { base_version: baseVersion } : {}),
  };
}

// --- The outbox document ---------------------------------------------------------------

const withOutboxLock = serialQueue();
/** The outbox as last read or written (the web's `pagehide` reads it synchronously). */
let outboxCache: OutboxEntry[] | null = null;
/** Whether the stored outbox has been read this launch. Until it is (a storage read that
 * failed), the cache holds only this launch's events, and nothing is written over the
 * stored ones: each read tries again and puts them first. */
let outboxRead = false;

const isEntry = (v: unknown): v is OutboxEntry =>
  isRecord(v) &&
  typeof v.connectionId === 'string' &&
  isRecord(v.event) &&
  typeof v.event.id === 'string';

async function readOutbox(): Promise<OutboxEntry[]> {
  if (outboxCache && outboxRead) return outboxCache;
  try {
    const raw = await getItemStrict<unknown>(OUTBOX_KEY);
    const stored = Array.isArray(raw) ? raw.filter(isEntry) : [];
    const have = new Set(stored.map((e) => e.event.id));
    outboxCache = [...stored, ...(outboxCache ?? []).filter((e) => !have.has(e.event.id))];
    outboxRead = true;
  } catch {
    outboxCache ??= [];
  }
  return outboxCache;
}

async function writeOutbox(next: OutboxEntry[]): Promise<void> {
  outboxCache = next;
  if (outboxRead) await setItem(OUTBOX_KEY, next);
  notify();
}

/** The outbox for a reader outside the lock: the cache once the stored outbox was read,
 * else read under the lock (a read that brings the stored events in never lands inside a
 * change made without them). */
function currentOutbox(): Promise<OutboxEntry[]> {
  return outboxRead && outboxCache ? Promise.resolve(outboxCache) : withOutboxLock(readOutbox);
}

/** Append events (already closed: immutable from here) to a connection's outbox. */
export async function appendEvents(connectionId: string, events: ListeningEvent[]): Promise<void> {
  if (events.length === 0) return;
  await withOutboxLock(async () => {
    const queue = await readOutbox();
    const have = new Set(queue.map((e) => e.event.id));
    const add = events.filter((e) => !have.has(e.id)).map((event) => ({ connectionId, event }));
    if (add.length > 0) await writeOutbox([...queue, ...add]);
  });
}

/** The events waiting for `connectionId` (all connections when absent), oldest first. */
export async function outboxEvents(connectionId?: string): Promise<OutboxEntry[]> {
  const queue = await currentOutbox();
  return connectionId === undefined
    ? [...queue]
    : queue.filter((e) => e.connectionId === connectionId);
}

async function removeEvents(ids: Set<string>): Promise<void> {
  if (ids.size === 0) return;
  await withOutboxLock(async () => {
    const queue = await readOutbox();
    const next = queue.filter((e) => !ids.has(e.event.id));
    if (next.length !== queue.length) await writeOutbox(next);
  });
}

// --- The open span ---------------------------------------------------------------------

/** One after another: a cut's close and the next span's write never cross. */
const spanOps = serialQueue();
let recovery: Promise<void> | null = null;
/** Whether this launch stored an open span (only offline ticks do): a close clears it then. */
let openSpanStored = false;

const isSpan = (v: unknown): v is OpenSpan =>
  isRecord(v) &&
  typeof v.connectionId === 'string' &&
  typeof v.libraryId === 'number' &&
  typeof v.path === 'string' &&
  isRecord(v.from) &&
  isRecord(v.to) &&
  typeof v.startedAt === 'string' &&
  typeof v.endedAt === 'string';

/**
 * Close a span a kill left open (the stored open span, at its last stored values) into the
 * outbox. Once per launch, before this launch's first span is written: every span write
 * waits on it.
 */
export function recoverOpenSpan(): Promise<void> {
  recovery ??= spanOps(async () => {
    const raw = await getItem<unknown>(OPEN_SPAN_KEY);
    if (!isSpan(raw)) return;
    openSpanStored = true;
    await closeInto(raw);
  }).catch((e: unknown) => console.warn('[listening] could not recover the open span', e));
  return recovery;
}

/** Keep the span being played (offline ticks; null clears it). */
export async function storeOpenSpan(span: OpenSpan | null): Promise<void> {
  await recoverOpenSpan();
  await spanOps(async () => {
    await setItem(OPEN_SPAN_KEY, span);
    // The pending count changes only when a span comes or goes, not with each rewrite.
    const was = openSpanStored;
    openSpanStored = span !== null;
    if (was !== openSpanStored) notify();
  });
}

/**
 * A span's `base_version` as it closes: the version acknowledged for its book now (its
 * mirror's `ack_version`), never below the one it opened with. Read at the close: one that
 * closed before its open's read came back would go with none known (0, a cold start to the
 * server), and what was acknowledged while it played (an unfinish the server applied, an
 * offer answered) is what the server resolves it on.
 */
async function baseAtClose(span: OpenSpan): Promise<number | undefined> {
  const mirror = await readMirror(span.connectionId, span.libraryId, span.path).catch(() => null);
  const acked = mirror?.ack_version;
  return acked === undefined ? span.baseVersion : Math.max(span.baseVersion ?? 0, acked);
}

/** Append `span`'s event (when it says something) and clear the stored open span, if any.
 * Run inside `spanOps`. */
async function closeInto(span: OpenSpan, event?: ListeningSpanEvent): Promise<void> {
  if (spanSaysSomething(span)) {
    const closed = event ?? spanToEvent({ ...span, baseVersion: await baseAtClose(span) });
    await appendEvents(span.connectionId, [closed]);
  }
  if (!openSpanStored) return;
  await setItem(OPEN_SPAN_KEY, null);
  openSpanStored = false;
  notify();
}

/**
 * Close `span` into its `listen` event (when it says something, on the base acknowledged by
 * now: `baseAtClose`) and clear the stored open span. `event` is the span's event when the
 * caller made it already (the web's `pagehide` sends it at once).
 */
export async function closeSpan(span: OpenSpan, event?: ListeningSpanEvent): Promise<void> {
  await recoverOpenSpan();
  await spanOps(() => closeInto(span, event));
}

/** The stored open span (tests, the pending count). */
export async function storedOpenSpan(): Promise<OpenSpan | null> {
  const raw = await getItem<unknown>(OPEN_SPAN_KEY);
  return isSpan(raw) ? raw : null;
}

// --- Per-connection sync state ---------------------------------------------------------

const withStateLock = serialQueue();

/** Whether a couldn't-sync entry is still kept (30 days). */
const stillKept = (f: CouldNotSync, now: number) => now - Date.parse(f.at) < COULD_NOT_SYNC_KEEP_MS;

async function readState(): Promise<Record<string, ConnectionSyncState>> {
  const raw = await getItem<unknown>(SYNC_KEY);
  return isRecord(raw) ? (raw as Record<string, ConnectionSyncState>) : {};
}

function updateState(
  connectionId: string,
  change: (s: ConnectionSyncState) => ConnectionSyncState | null,
): Promise<void> {
  return withStateLock(async () => {
    const all = await readState();
    const next = change(all[connectionId] ?? {});
    if (next) all[connectionId] = next;
    else delete all[connectionId];
    await setItem(SYNC_KEY, all);
    notify();
  });
}

/** A connection's last sync and couldn't-sync list (entries past 30 days left out). */
export async function syncStateOf(
  connectionId: string,
  now = Date.now(),
): Promise<ConnectionSyncState> {
  const s = (await readState())[connectionId] ?? {};
  const failed = (s.failed ?? []).filter((f) => stillKept(f, now));
  return { ...(s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}), failed };
}

async function moveToFailed(
  connectionId: string,
  items: { event: ListeningEvent; reason: string }[],
) {
  if (items.length === 0) return;
  const at = new Date().toISOString();
  await updateState(connectionId, (s) => {
    const now = Date.now();
    const kept = (s.failed ?? []).filter(
      (f) => stillKept(f, now) && !items.some((i) => i.event.id === f.event.id),
    );
    return {
      ...s,
      failed: [...kept, ...items.map((i) => ({ ...i, at }))].slice(-MAX_COULD_NOT_SYNC),
    };
  });
  await removeEvents(new Set(items.map((i) => i.event.id)));
}

/** Discard one event from the couldn't-sync list. */
export function discardFailed(connectionId: string, eventId: string): Promise<void> {
  return updateState(connectionId, (s) => ({
    ...s,
    failed: (s.failed ?? []).filter((f) => f.event.id !== eventId),
  }));
}

// --- Which path a capture takes ----------------------------------------------------------

/** Connections whose server answered the sync route 404/405 (rolled back) this launch. */
const rolledBack = new Set<string>();

/**
 * Whether listening on `connectionId` is recorded as events: its cached `/server` says
 * `listening_sync: true` and the route has not been found missing since. False or unknown:
 * today's PUT progress + POST history, unchanged.
 */
export function usesListeningSync(connectionId: string): boolean {
  return !rolledBack.has(connectionId) && cachedCapability(connectionId, 'listening_sync') === true;
}

// --- Sending ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<void>>();
const flushAgain = new Set<string>();
const chunkSizes = new Map<string, number>();

/**
 * Send a connection's outbox. One flush at a time per connection: a call while one runs
 * makes it go round once more when it ends (a sync that left more goes on by itself).
 */
export function flushOutbox(connectionId: string): Promise<void> {
  const running = inFlight.get(connectionId);
  if (running) {
    flushAgain.add(connectionId);
    return running;
  }
  const run = (async () => {
    try {
      do {
        flushAgain.delete(connectionId);
        await flushOnce(connectionId);
      } while (flushAgain.has(connectionId));
    } catch (e) {
      console.warn('[listening] sync failed', e);
    } finally {
      inFlight.delete(connectionId);
    }
  })();
  inFlight.set(connectionId, run);
  return run;
}

/** Send every connection's outbox (a launch, the foreground). */
export async function flushAllOutboxes(): Promise<void> {
  if (!sessionReady()) return;
  await recoverOpenSpan();
  const ids = new Set((await currentOutbox()).map((e) => e.connectionId));
  await Promise.all([...ids].map((cid) => flushOutbox(cid)));
}

/**
 * The listens that haven't reached `connectionId`'s server, after a last send while it is
 * reachable (sign-out and removing a server confirm when any are left).
 */
export async function unsentListens(connectionId: string): Promise<number> {
  if (isReachable(connectionId)) await flushOutbox(connectionId);
  return (await pendingSaves(connectionId)).listens;
}

/** A batch's envelope with this attempt's clock. */
function syncBody(events: ListeningEvent[], deviceId: string) {
  return { device_id: deviceId, sent_at: new Date().toISOString(), events };
}

/** How many rounds one flush makes at most (a 500-event backlog in chunks of 200 is 3). */
const MAX_ROUNDS = 50;

async function flushOnce(connectionId: string): Promise<void> {
  if (!sessionReady()) return;
  await recoverOpenSpan();
  const client = resolveClient(connectionId);
  // A connection gone: its events are purged with it (`onConnectionRemoved`).
  if (!client) return;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const pending = await outboxEvents(connectionId);
    if (pending.length === 0) return;
    const chunk = pending.slice(0, chunkSizes.get(connectionId) ?? MAX_CHUNK);
    if ((await sendChunk(connectionId, client, chunk)) === 'stop') return;
  }
}

/** What one request's outcome asks of the flush. */
type Next = 'more' | 'stop';

async function sendChunk(
  connectionId: string,
  client: ApiClient,
  chunk: OutboxEntry[],
): Promise<Next> {
  try {
    const deviceId = await getDeviceId();
    const answer = await client.syncListening(
      syncBody(
        chunk.map((e) => e.event),
        deviceId,
      ),
    );
    noteSuccess(connectionId);
    await applyAnswer(connectionId, chunk, answer);
    return 'more';
  } catch (e) {
    if (!(e instanceof ApiError)) {
      // No answer: keep everything; only a check marks the server down.
      noteFailure(connectionId, e);
      return 'stop';
    }
    if (e.status === 404 || e.status === 405) {
      await rollBack(connectionId, client);
      return 'stop';
    }
    if (e.status === 413 || e.code === 'too_many_events') {
      if (chunk.length > 1) {
        chunkSizes.set(connectionId, Math.max(1, Math.floor(chunk.length / 2)));
        return 'more';
      }
      await moveToFailed(connectionId, [{ event: chunk[0].event, reason: 'invalid' }]);
      return 'more';
    }
    if (e.status === 400) return sendOneByOne(connectionId, client, chunk);
    // 401 (the client has flagged the sign-in), 403, 5xx: keep them for a later try.
    return 'stop';
  }
}

/** A 400 on a batch: each event alone, once; one still refused alone can never be sent. */
async function sendOneByOne(
  connectionId: string,
  client: ApiClient,
  chunk: OutboxEntry[],
): Promise<Next> {
  if (chunk.length === 1) {
    await moveToFailed(connectionId, [{ event: chunk[0].event, reason: 'invalid' }]);
    return 'more';
  }
  for (const entry of chunk) {
    try {
      const answer = await client.syncListening(syncBody([entry.event], await getDeviceId()));
      await applyAnswer(connectionId, [entry], answer);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        await moveToFailed(connectionId, [{ event: entry.event, reason: 'invalid' }]);
        continue;
      }
      if (!(e instanceof ApiError)) noteFailure(connectionId, e);
      return 'stop';
    }
  }
  return 'more';
}

/** Told of every sync answer's progress rows (the place reconcile's offer check). */
type AnswerListener = (connectionId: string, rows: Progress[]) => void;
const answerListeners = new Set<AnswerListener>();

/** Be told of each sync answer's rows; returns the unsubscribe. */
export function onSyncAnswer(listener: AnswerListener): () => void {
  answerListeners.add(listener);
  return () => answerListeners.delete(listener);
}

/**
 * Whether the server kept this device's event for a book in the answer (applied, or a
 * diverged event it kept): the rule for acknowledging the row's version (pure).
 */
export function keptMine(
  row: Pick<Progress, 'library_id' | 'path' | 'device_id'>,
  deviceId: string,
  sent: ListeningEvent[],
  results: Map<string, ListeningSyncResult>,
): boolean {
  if (row.device_id !== deviceId) return false;
  return sent.some((e) => {
    if (e.library_id !== row.library_id || e.path !== row.path) return false;
    const r = results.get(e.id);
    return r?.status === 'applied' || (r?.status === 'diverged' && r.kept === 'event');
  });
}

async function applyAnswer(
  connectionId: string,
  sent: OutboxEntry[],
  answer: ListeningSyncResponse,
) {
  const results = new Map((answer.results ?? []).map((r) => [r.id, r]));
  const done = new Set<string>();
  const rejected: { event: ListeningEvent; reason: string }[] = [];
  for (const { event } of sent) {
    const r = results.get(event.id);
    if (!r) continue; // no result for it: try again later
    if (r.status === 'rejected') rejected.push({ event, reason: r.reason ?? 'invalid' });
    else done.add(event.id);
  }
  await removeEvents(done);
  await moveToFailed(connectionId, rejected);
  await updateState(connectionId, (s) => ({ ...s, lastSyncAt: new Date().toISOString() }));

  const rows = answer.progress ?? [];
  const deviceId = await getDeviceId();
  const events = sent.map((e) => e.event);
  for (const row of rows) {
    queryClient.setQueryData(qk.progress(connectionId, row.library_id, row.path), row);
    if (keptMine(row, deviceId, events, results)) {
      await ackVersion(connectionId, row.library_id, row.path, row.version, row);
    }
  }
  if (events.some((e) => e.kind === 'listen')) {
    void queryClient.invalidateQueries({ queryKey: qk.historyAll(connectionId) });
  }
  for (const listener of answerListeners) listener(connectionId, rows);
}

// --- The rollback ----------------------------------------------------------------------

/**
 * The outbox as legacy saves, one per book (pure): the newest listen's end as the place,
 * finished when the newest finish-state change is a `finish` that is not older than it.
 */
export function legacySavesOf(
  connectionId: string,
  entries: OutboxEntry[],
  deviceId: string,
): ProgressSave[] {
  type Book = { listen?: ListeningSpanEvent; state?: ListeningFinishEvent };
  const books = new Map<string, Book>();
  for (const { event } of entries) {
    const key = `${event.library_id}\u0000${event.path}`;
    const book = books.get(key) ?? {};
    if (event.kind === 'listen') {
      if (!book.listen || event.ended_at >= book.listen.ended_at) book.listen = event;
    } else if (!book.state || event.at >= book.state.at) {
      book.state = event;
    }
    books.set(key, book);
  }
  const saves: ProgressSave[] = [];
  for (const { listen, state } of books.values()) {
    const ref = listen ?? state;
    if (!ref) continue;
    const finished = state?.kind === 'finish' && (!listen || state.at >= listen.ended_at);
    const duration = listen?.duration ?? 0;
    const listenedAt = listen?.ended_at ?? '';
    const at = state && state.at > listenedAt ? state.at : listenedAt;
    saves.push({
      connectionId,
      libraryId: ref.library_id,
      path: ref.path,
      position: finished && duration > 0 ? duration : (listen?.to_pos ?? 0),
      duration,
      finished,
      playback_speed: listen?.playback_speed ?? 1,
      device_id: deviceId,
      updated_at: at,
    });
  }
  return saves.filter((s) => s.position > 0 || s.finished || !!s.updated_at);
}

/** Drop a connection's events from the outbox; returns them. */
function takeConnection(connectionId: string): Promise<OutboxEntry[]> {
  return withOutboxLock(async () => {
    const queue = await readOutbox();
    const mine = queue.filter((e) => e.connectionId === connectionId);
    if (mine.length > 0) await writeOutbox(queue.filter((e) => e.connectionId !== connectionId));
    return mine;
  });
}

/**
 * A 404/405 on the sync route: rolled back only when the server says so, its `/server`
 * answering without `listening_sync` (anything else answering at the address, a home
 * address another host holds on this network, keeps the outbox for a later send). The
 * events go as legacy saves, then leave the outbox (a kill between sends them again).
 */
async function rollBack(connectionId: string, client: ApiClient): Promise<void> {
  const info = await client.serverInfo().catch(() => null);
  if (!info || info.capabilities?.listening_sync) return;
  rolledBack.add(connectionId);
  void queryClient.invalidateQueries({ queryKey: qk.server(connectionId) });
  const mine = await outboxEvents(connectionId);
  const deviceId = await getDeviceId();
  for (const save of legacySavesOf(connectionId, mine, deviceId)) {
    await saveProgress(client, save);
  }
  await removeEvents(new Set(mine.map((e) => e.event.id)));
}

// --- The web page going ------------------------------------------------------------------

/**
 * Web `pagehide`: send what waits (plus `extra`, the span closed this moment) in one
 * keepalive request per connection, as much as fits in `KEEPALIVE_BYTES`. Synchronous up to
 * the requests (the page is going); an answer that still arrives is applied as usual, and
 * anything unanswered stays in the outbox (a resend is a `duplicate`).
 */
export function sendOnPageHide(extra: OutboxEntry[], deviceId: string): void {
  if (!sessionReady()) return;
  const byConnection = new Map<string, OutboxEntry[]>();
  const seen = new Set<string>();
  for (const entry of [...(outboxCache ?? []), ...extra]) {
    if (seen.has(entry.event.id)) continue;
    seen.add(entry.event.id);
    const list = byConnection.get(entry.connectionId) ?? [];
    list.push(entry);
    byConnection.set(entry.connectionId, list);
  }
  for (const [cid, entries] of byConnection) {
    const client = resolveClient(cid);
    if (!client) continue;
    const fit = fitKeepalive(entries);
    if (fit.length === 0) continue;
    void client
      .syncListening(
        syncBody(
          fit.map((e) => e.event),
          deviceId,
        ),
        { keepalive: true },
      )
      .then((answer) => applyAnswer(cid, fit, answer))
      .catch(() => undefined);
  }
}

/** The entries, oldest first, that fit in one keepalive request (pure). */
export function fitKeepalive(entries: OutboxEntry[], limit = KEEPALIVE_BYTES): OutboxEntry[] {
  // The envelope (device id, sent_at, brackets) is well under 200 bytes.
  let size = 200;
  const out: OutboxEntry[] = [];
  for (const entry of entries) {
    size += JSON.stringify(entry.event).length + 1;
    if (size > limit || out.length >= MAX_CHUNK) break;
    out.push(entry);
  }
  return out;
}

// --- Change notifications (the UI) -------------------------------------------------------

const changeListeners = new Set<() => void>();

function notify() {
  for (const listener of changeListeners) listener();
}

/** Be told when the outbox, the open span or a sync state changes; returns the unsubscribe. */
export function onOutboxChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

// --- Removal ------------------------------------------------------------------------------

// Removing a connection orphans its listening (signing in again starts from the server's
// record), like its queued saves: drop its events, its open span and its sync state.
onConnectionRemoved(async (id) => {
  chunkSizes.delete(id);
  rolledBack.delete(id);
  await Promise.all([
    takeConnection(id),
    spanOps(async () => {
      const span = await storedOpenSpan();
      if (span?.connectionId !== id) return;
      await setItem(OPEN_SPAN_KEY, null);
      openSpanStored = false;
    }),
    updateState(id, () => null),
  ]);
});

/** Test-only: forget what this module holds in memory. */
export function resetOutboxForTests(): void {
  outboxCache = null;
  outboxRead = false;
  recovery = null;
  openSpanStored = false;
  rolledBack.clear();
  chunkSizes.clear();
  inFlight.clear();
  flushAgain.clear();
  answerListeners.clear();
}
