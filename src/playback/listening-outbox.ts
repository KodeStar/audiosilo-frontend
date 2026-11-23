import { Platform } from 'react-native';

import { ApiError, type ApiClient } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { liveClient } from '@/api/live-client';
import { onProxyRefusalsOver } from '@/api/proxy-refusal';
import { noteRateLimit, onRateLimitOver, rateLimited } from '@/api/rate-limit';
import { cachedCapability, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { isReachable, noteFailure, noteSuccess } from '@/api/reachability';
import { keepServerAnswer, keepServerFlag } from '@/api/server-snapshots';
import type {
  ListeningEvent,
  ListeningFinishEvent,
  ListeningStart,
  ListeningSpanEvent,
  ListeningSyncResponse,
  ListeningSyncResult,
  Progress,
} from '@/api/types';
import { downloadBookLength } from '@/downloads/kept-offline';
import { resolveConnectionId, sameConnection } from '@/lib/connection-id';
import { contentKey } from '@/lib/content-key';
import { randomUUID } from '@/lib/random';
import { getItem, getItemStrict, setItem, setItemStrict } from '@/lib/storage';
import { onStoredChange } from '@/lib/tab-channel';
import { hasWebLocks, holdWebLock, queryWebLocks, sharedWebLock, tabLock } from '@/lib/tab-lock';
import {
  isRecord,
  LISTENING_OPEN_SPAN_KEY as OPEN_SPAN_KEY,
  LISTENING_OUTBOX_KEY as OUTBOX_KEY,
  LISTENING_SYNC_KEY as SYNC_KEY,
} from '@/lib/storage-keys';
import { onConnectionRemoved } from '@/stores/session';

import { captureConnectionGenerations, connectionGeneration } from './connection-generation';
import { isPos, type OpenSpan, type SpanEnd, type StoredSpan, storedSpans } from './open-span-doc';
import {
  ackVersion,
  bookPlace,
  getDeviceId,
  mirrorSpanEnd,
  noteClockSkew,
  pendingSaves,
  type ProgressSave,
  readMirror,
  saveProgress,
} from './progress-sync';
import { wallClockSeconds } from './rate';
import { cutPlayingSpan } from './span-cut';
import { provideStoredSkews } from './stored-skews';

export type { OpenSpan, SpanEnd } from './open-span-doc';

/**
 * Sync v2's listening outbox (Track W1, CROSS-REPO section 25): on a server with
 * `listening_sync` (or one not yet known: `usesListeningSync`), the player records listening
 * as events instead of saving a place. A span of playing is one `listen` event (whole-book
 * seconds on this device's timeline, plus each end's audio file and in-file seconds,
 * fe#188), and marking the book finished or not is a `finish`/`unfinish`. Events wait here, append-only, until their server answers for them
 * (`POST /me/listening/sync`); the server resolves each against the stored place by its
 * `base_version` (this device's acknowledged version), so an old offline span never moves a
 * further place back.
 *
 * - `audiosilo.listeningOutbox`: the closed events, each with its `connectionId`. An event is
 *   immutable once it is here (the store closes spans into new ones; nothing merges). On the
 *   web, where every tab shares it, a `finish` also carries the marks of its sends
 *   (`OutboxEntry`), which an Undo in another tab reads.
 * - `audiosilo.listeningOpenSpan`: the span being played (one per web tab playing),
 *   stored every few seconds, so a span a kill left open is closed at its last stored
 *   values on the next launch (`recoverOpenSpan`).
 * - `audiosilo.listeningSync`: per connection, when it last synced, the events it couldn't
 *   sync (the "couldn't sync" list: rejected, `too_large` or `too_old`, kept 30 days or until
 *   discarded) and its server's clock skew (`clockSkewMs`).
 *
 * Sending (`flushOutbox`): one request in flight per connection, chunks of 200 events, the
 * device clock (`sent_at`) set per attempt. Every status but `rejected` removes the event;
 * `rejected` moves it to the couldn't-sync list. A network error or 5xx keeps everything; a
 * 413 or `too_many_events` halves the chunk, and one event alone still 413 is moved to the
 * list (`too_large`); a 400 on a batch sends its events one by one once, and one still
 * refused alone is moved to the list. An event older than 90 days is moved to the list
 * unsent (`too_old`, `giveUpOld`). A 404/405 that the server's own `/server` confirms (no
 * `listening_sync`) means it was rolled back to one without the route: the connection's
 * outbox becomes one legacy save per book (`legacySaveOf`) and the player saves by PUT from
 * then on (`usesListeningSync`).
 */

/**
 * An event waiting for its server. The event is immutable; a `finish` also carries what
 * happened to its sends, where every tab of the web player reads it (the tabs share the
 * stored outbox but not each other's memory, so an Undo in one tab must see a send another
 * tab made: `markOut`, `withdrawFinish`):
 * - `out`: the requests carrying it that are out, by the tab that sent each, with the time
 *   (ms) each is over by at the latest. A tab takes its own mark off when its request ends;
 *   one still standing past its time was left by a tab that went with its request: the
 *   server may hold the finish.
 * - `maybeReached`: a request carried it while its server looked reachable and got no
 *   answer, so the server may hold it (`carried`).
 */
export type OutboxEntry = {
  connectionId: string;
  event: ListeningEvent;
  out?: Record<string, number>;
  maybeReached?: true;
};

/** An event its server rejected, kept to show (the account's couldn't-sync list). */
export type CouldNotSync = { event: ListeningEvent; reason: string; at: string };

/** What the account card shows of one connection's sync, and its server's clock: how far
 * ahead of this device's it was at the last sync answer (ms, `clockSkewMs`). */
export type ConnectionSyncState = {
  lastSyncAt?: string;
  failed?: CouldNotSync[];
  clockSkewMs?: number;
};

/** At most this many events per request (the server takes 500). */
const MAX_CHUNK = 200;
/** The web's `pagehide` sends at most this much in its keepalive request (64 KB limit). */
const KEEPALIVE_BYTES = 60_000;
/** A rejected event stays on the couldn't-sync list this long. */
export const COULD_NOT_SYNC_KEEP_MS = 30 * 24 * 60 * 60_000;
/** At most this many (the newest) per connection: a book the server keeps refusing adds
 * one each cut (15 s, or 60 s) while it plays. */
export const MAX_COULD_NOT_SYNC = 100;
/** A span shorter than this that moved nowhere says nothing (a play stopped at once). */
const EMPTY_SPAN_MS = 1_000;
/** The longest wall time an event's span may claim: under the server's 24 h bound (a span
 * longer is refused `invalid`). The store cuts a span every hour, but only its tick does,
 * and a JS runtime whose timers stood still (a frozen tab, a suspended app) can close one
 * that ran longer (fe#208). */
export const MAX_EVENT_SPAN_MS = 23 * 60 * 60_000;
/** An event older than this is given up without a send: the server refuses one older
 * than 90 days (`too_old`, its `syncRejectAge`), so it could only ever wait (keeping its
 * book pending, which holds off another device's finish there) or be refused. The server's
 * own bound, so the list's "more than 90 days old" is true of every one given up here; one
 * a device clock a little behind still sends is refused `too_old` and lands in the same
 * list (fe#211). */
export const GIVE_UP_AGE_MS = 90 * 24 * 60 * 60_000;

// --- Building events -------------------------------------------------------------------

/** A new event id (a UUID: the server takes 1-64 of `[A-Za-z0-9_-]`). */
export const newEventId = (): string => randomUUID();

/**
 * A span's start as its event claims it (pure): its own, unless the span ran longer than
 * `MAX_EVENT_SPAN_MS` of wall clock (timers that stood still). The start is then moved up
 * to as long before the end as the audio it covered takes to play (at least a second, at
 * most the bound): the listening the server counts stays, the impossible wall time goes.
 */
function claimedStart(span: OpenSpan, endedAt: string): string {
  const ended = Date.parse(endedAt);
  const started = Date.parse(span.startedAt);
  if (!(ended - started > MAX_EVENT_SPAN_MS)) return span.startedAt;
  const played = wallClockSeconds(Math.abs(span.to.pos - span.from.pos), span.speed) * 1000;
  const wall = Math.min(MAX_EVENT_SPAN_MS, Math.max(1000, Number.isFinite(played) ? played : 0));
  return new Date(ended - wall).toISOString();
}

/** A span as its `listen` event (pure), with the id it took when it opened (else `id`).
 * Each end's file pair is sent only whole. */
export function spanToEvent(span: OpenSpan, id: string = newEventId()): ListeningSpanEvent {
  const endedAt = span.endedAt < span.startedAt ? span.startedAt : span.endedAt;
  const event: ListeningSpanEvent = {
    id: span.id ?? id,
    kind: 'listen',
    library_id: span.libraryId,
    path: span.path,
    from_pos: Math.max(0, span.from.pos),
    to_pos: Math.max(0, span.to.pos),
    started_at: claimedStart(span, endedAt),
    ended_at: endedAt,
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

/** Whether every number in `event` is finite (pure): one that is not is never enqueued (JSON
 * has no NaN, so a NaN would reach the server as `null`, or be stored as one). */
export function eventIsFinite(event: ListeningEvent): boolean {
  return Object.values(event).every((v) => typeof v !== 'number' || Number.isFinite(v));
}

/** Whether anything was heard in a span: it ran a second, or the place moved one (pure). */
function spanHeard(span: OpenSpan): boolean {
  const ms = Date.parse(span.endedAt) - Date.parse(span.startedAt);
  return ms >= EMPTY_SPAN_MS || Math.abs(span.to.pos - span.from.pos) >= 1;
}

/** The starts that say a deliberate move. */
const MOVE_STARTS: ReadonlySet<ListeningStart> = new Set(['jump', 'moved_back', 'restart', 'stay']);

/** Whether a span carries anything: listening, or a deliberate move (pure). */
export function spanSaysSomething(span: OpenSpan): boolean {
  return spanHeard(span) || MOVE_STARTS.has(span.start);
}

/**
 * A deliberate move nothing was heard after (a pause right behind a seek; pure): all it says
 * is the move, like a move made while paused. Stamped ms after the span before it, its event
 * can lose to that span's when they are sent apart (`not_applied`/`older`: two batches' clock
 * shifts differ by their latency), so the next span carries the move too. The watch's
 * `Spans.isBareMove`.
 */
export function spanIsBareMove(span: OpenSpan): boolean {
  return spanSaysSomething(span) && !spanHeard(span);
}

/** A place this little from another is the same place: a seek lands a hair off the place it
 * was asked for (the transport's 0.01, the watch's `ChapterNav.AT_START`). */
const SAME_PLACE = 0.01;

/**
 * A move to where the place already is moves nothing (Previous at the book's start; pure):
 * no span is closed for it and no event says it. Either end unknown, or a place that is not
 * a number (NaN compares false), is not this; nor is a move to another file, whatever the
 * timeline says (a book whose file lengths are unknown starts every file at 0). The watch's
 * `Spans.movesNowhere`.
 */
export function movesNowhere(from: SpanEnd | null | undefined, to: SpanEnd | null): boolean {
  if (!from || !to) return false;
  if (from.file !== undefined && to.file !== undefined && from.file !== to.file) return false;
  return Math.abs(to.pos - from.pos) < SAME_PLACE;
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

/** Whether other tabs may share this storage (the web, or a runtime with Web Locks): the
 * stored documents are then read again under their lock each time, never from a copy. */
function sharedAcrossTabs(): boolean {
  return Platform.OS === 'web' || hasWebLocks();
}

/**
 * Run an outbox read-modify-write alone: in this tab and across every tab of the web player
 * (`tabLock`: Web Locks, else a `localStorage` lease on plain http), since the tabs share the
 * stored outbox. Under it the stored outbox is read again each time (`readOutbox`), so a tab
 * never writes over events another tab added or sent.
 */
const withOutboxLock = tabLock(OUTBOX_KEY);
/** The outbox as last read or written (the web's `pagehide` reads it synchronously). */
let outboxCache: OutboxEntry[] | null = null;
/** Whether the stored outbox has been read this launch. Until it is (a storage read that
 * failed), the cache holds only this launch's events, and nothing is written over the
 * stored ones: each read tries again and puts them first. */
let outboxRead = false;
/** Whether this tab's last outbox write failed (a full storage): its copy then holds events
 * storage does not, so the next read merges them back in rather than taking storage alone. */
let outboxUnsaved = false;

const isEntry = (v: unknown): v is OutboxEntry =>
  isRecord(v) &&
  typeof v.connectionId === 'string' &&
  isRecord(v.event) &&
  typeof v.event.id === 'string';

const entriesOf = (raw: unknown): OutboxEntry[] => (Array.isArray(raw) ? raw.filter(isEntry) : []);

async function readOutbox(): Promise<OutboxEntry[]> {
  if (outboxCache && outboxRead && !sharedAcrossTabs()) return outboxCache;
  try {
    const stored = entriesOf(await getItemStrict<unknown>(OUTBOX_KEY));
    if (outboxRead && !outboxUnsaved) {
      // Read before: storage is the outbox (another tab may have changed it since).
      outboxCache = stored;
    } else {
      // The first read, or a copy storage could not take: the stored events first, then this
      // tab's own (one sent meanwhile goes again as a `duplicate`).
      const have = new Set(stored.map((e) => e.event.id));
      outboxCache = [...stored, ...(outboxCache ?? []).filter((e) => !have.has(e.event.id))];
      outboxRead = true;
    }
  } catch {
    outboxCache ??= [];
  }
  return outboxCache;
}

/** Write the outbox; resolves to whether storage holds it now (false: the write failed,
 * so this tab's copy holds a change storage does not, `outboxUnsaved`). True also while the
 * stored outbox was never read: nothing is written over it then, and what this launch
 * holds is in its copy alone. */
async function writeOutbox(next: OutboxEntry[]): Promise<boolean> {
  outboxCache = next;
  let stored = true;
  if (outboxRead) {
    try {
      await setItemStrict(OUTBOX_KEY, next);
      outboxUnsaved = false;
    } catch {
      outboxUnsaved = true;
      stored = false;
    }
  }
  notify();
  return stored;
}

/**
 * Another tab changed the stored outbox (the web's `storage` event, `raw` its new value):
 * this tab's copy follows, so its count and its `pagehide` send see what is there now.
 * Nothing before this tab read the stored outbox itself (its first read merges).
 */
export function refreshOutboxFrom(raw: string | null): void {
  if (!outboxRead || outboxUnsaved) return;
  try {
    outboxCache = parseOutbox(raw);
  } catch {
    return;
  }
  notify();
}

/** The outbox in a stored value as `localStorage` holds it (throws on a value not JSON). */
const parseOutbox = (raw: string | null): OutboxEntry[] => (raw ? entriesOf(JSON.parse(raw)) : []);

onStoredChange(OUTBOX_KEY, refreshOutboxFrom);

/** The outbox for a reader outside the lock: the cache once the stored outbox was read,
 * else read under the lock (a read that brings the stored events in never lands inside a
 * change made without them). */
function currentOutbox(): Promise<OutboxEntry[]> {
  return outboxRead && outboxCache ? Promise.resolve(outboxCache) : withOutboxLock(readOutbox);
}

/** Append events (already closed: immutable from here) to a connection's outbox. `since`:
 * the connection's sign-in (`connectionGeneration`) the events belong to, when they were
 * made before an await: nothing is appended once it was signed out since. */
export async function appendEvents(
  connectionId: string,
  given: ListeningEvent[],
  since?: number,
): Promise<void> {
  const events = given.filter(eventIsFinite);
  if (events.length < given.length) console.warn('[listening] dropped an event with no place');
  await appendEntries(
    events.map((event) => ({ connectionId, event })),
    since,
  );
}

/** Append entries (none already there, by event id) to the outbox: at the end, or before
 * the first entry `before` names (a finish put back where it was: `withdrawFinish`).
 * Nothing when `since` is not the entries' connection's sign-in any more (checked under
 * the lock, so the removal's purge, queued behind it or ahead of it, never misses one). */
async function appendEntries(
  entries: OutboxEntry[],
  since?: number,
  before?: (queue: OutboxEntry[], entry: OutboxEntry) => number,
): Promise<void> {
  if (entries.length === 0) return;
  await withOutboxLock(async () => {
    if (since !== undefined && entries.some((e) => connectionGeneration(e.connectionId) !== since))
      return;
    const queue = await readOutbox();
    const have = new Set(queue.map((e) => e.event.id));
    const add = entries.filter((e) => !have.has(e.event.id));
    if (add.length === 0) return;
    const next = [...queue];
    for (const entry of add) {
      const at = before ? before(next, entry) : -1;
      next.splice(at < 0 ? next.length : at, 0, entry);
    }
    await writeOutbox(next);
  });
}

/**
 * Append `events` behind every close queued before them (`closeSpan`) and every other event
 * appended this way: the outbox's order is the order a sync sends, so a book's last span
 * goes before its `finish` (server#359: a 12 s book's finish went first, found no session
 * to mark, and the span then opened one that stayed unfinished), and a paused move after
 * the close of the span before it. Waiting from the call, they are in `queued`, so the web's
 * `pagehide` carries them too, as it carries the closes ahead of them (a page going, or an
 * app killed, while the close waited its turn otherwise lost the finish with it).
 * `baseVersion` gives each its `base_version` as it is appended (read then: what was
 * acknowledged by the closes ahead of it). The copy waiting takes it too, read at the call
 * (the web's storage answers before the page can go), when that is past the one it was made
 * with: a move made with no span closed ahead of it was made with none, and base 0 is a
 * place this device never saw to the server, which then keeps the further place over a move
 * back or a Stay (and the copy appended later, the same id, is a `duplicate`).
 */
export async function appendInTurn(
  connectionId: string,
  events: ListeningEvent[],
  baseVersion?: () => Promise<number | undefined>,
): Promise<void> {
  appendsInTurn.set(connectionId, (appendsInTurn.get(connectionId) ?? 0) + 1);
  try {
    if (baseVersion) {
      void baseVersion()
        .catch(() => undefined)
        .then((base) => {
          if (base === undefined) return;
          for (const event of events) {
            // Still waiting (in its place in the order: a key set again keeps it).
            if (!queued.has(event.id) || (event.base_version ?? 0) >= base) continue;
            queued.set(event.id, { connectionId, event: { ...event, base_version: base } });
          }
        });
    }
    await inTurn(connectionId, events, async (since) => {
      const base = baseVersion ? await baseVersion().catch(() => undefined) : undefined;
      const final = base === undefined ? events : events.map((e) => ({ ...e, base_version: base }));
      await appendEvents(connectionId, final, since);
    });
  } finally {
    const left = (appendsInTurn.get(connectionId) ?? 1) - 1;
    if (left > 0) appendsInTurn.set(connectionId, left);
    else appendsInTurn.delete(connectionId);
  }
}

/** Run `op` in the outbox's turn for `connectionId`: after every close (`closeSpan`) and
 * append in turn (`appendInTurn`) asked before it, before any asked after it. An offer
 * answered by a move acknowledges its row there, once the span it ends is in the outbox
 * (`answerAfterSpan` in store.ts). */
export function afterInTurn(connectionId: string, op: () => Promise<void>): Promise<void> {
  return inTurn(connectionId, [], op);
}

/** Run `op` in its turn (`spanOps`, after a crashed tab's span is recovered), with `events`
 * waiting in `queued` until it ends, so the web's `pagehide` carries them meanwhile. `op`
 * gets the connection's sign-in at the call (`since`): what it appends belongs to that one. */
async function inTurn(
  connectionId: string,
  events: ListeningEvent[],
  op: (since: number) => Promise<void>,
): Promise<void> {
  const since = connectionGeneration(connectionId);
  for (const event of events) queued.set(event.id, { connectionId, event });
  try {
    await recoverOpenSpan();
    await spanOps(() => op(since));
  } finally {
    for (const event of events) queued.delete(event.id);
  }
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

/** One after another, in this tab and across tabs (`tabLock`): a cut's close and the next
 * span's write never cross, and two tabs never write over each other's span. */
const spanOps = tabLock(OPEN_SPAN_KEY);
let recovery: Promise<void> | null = null;
/** Who this tab is (the app: this launch), for the spans it stores. */
let tabId = randomUUID();
const OWNER_KEY = 'audiosilo.openSpanOwner';
const spanOwnerLock = (id: string) => `audiosilo-open-span:${id}`;
/** Set while this document has a stored span. A close releases its Web Lock. */
let releaseSpanOwner: (() => void) | null = null;

function clearSpanOwner() {
  releaseSpanOwner?.();
  releaseSpanOwner = null;
}

function tabSession(): Storage | null {
  try {
    return Platform.OS === 'web' ? (globalThis.sessionStorage ?? null) : null;
  } catch {
    return null;
  }
}
const ownerSession = tabSession();

/** A new or duplicated tab may inherit sessionStorage. A live document keeps its own
 * span lock. On plain HTTP only a reload can claim the previous document's span. */
async function previousOwner(spans: StoredSpan[]): Promise<string | null> {
  try {
    const owner = ownerSession?.getItem(OWNER_KEY);
    if (!owner || !spans.some((s) => s.owner === owner)) return null;
    const locks = await queryWebLocks();
    if (locks) return locks.has(spanOwnerLock(owner)) ? null : owner;
    const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    return nav?.type === 'reload' ? owner : null;
  } catch {
    return null;
  }
}

/** A span stored by another tab within this long is that tab's, still playing (it stores
 * its span every 5 s while it plays); one older was left by a tab that closed or crashed. */
export const LIVE_SPAN_MS = 30_000;
/** The same for a tab still on a build before the span list (its span has no `owner`): it
 * rewrites its span only every 15 s, and only while it plays offline. */
const OLD_BUILD_LIVE_MS = LIVE_SPAN_MS + 15_000;
/** A web tab found another tab's live span at launch: it looks again once that would have
 * gone stale. */
let staleCheck: ReturnType<typeof setTimeout> | null = null;

async function readSpans(): Promise<StoredSpan[]> {
  return storedSpans(await getItem<unknown>(OPEN_SPAN_KEY));
}

/** Write the stored spans (none: cleared). */
async function writeSpans(spans: StoredSpan[]): Promise<void> {
  await setItem(OPEN_SPAN_KEY, spans.length > 0 ? spans : null);
}

/** A stored span without the bookkeeping. */
function bare({ owner: _owner, keptAt: _keptAt, ...span }: StoredSpan): OpenSpan {
  return span;
}

/** Whether a stored span was left by a tab or launch no longer playing it. In the app every
 * span a launch finds is a previous launch's; on the web another tab's is left alone while
 * it is live (`LIVE_SPAN_MS`), and so is the span of a tab still on an older build while
 * its end is recent (`OLD_BUILD_LIVE_MS`): each sweep of a span that tab goes on rewriting
 * would send it again under a new id. A keep further in the future than that (the clock
 * set back since) is no sign of life either. */
function leftBehind(span: StoredSpan, now: number): boolean {
  if (span.owner === tabId) return false;
  if (Platform.OS !== 'web') return true;
  const oldBuild = span.owner === undefined;
  const keptAt = oldBuild ? Date.parse(span.endedAt) : span.keptAt;
  if (typeof keptAt !== 'number' || !Number.isFinite(keptAt)) return true;
  return Math.abs(now - keptAt) >= (oldBuild ? OLD_BUILD_LIVE_MS : LIVE_SPAN_MS);
}

/** Close every span left behind into the outbox, and bring this device's record of each
 * one's book up to where it ended (`mirrorSpanEnd`). Run inside `spanOps`. Returns whether a
 * live span of another tab is still stored (`live`), and the connections whose spans were
 * closed (`swept`). */
async function closeLeftBehind(
  launch: boolean,
  generationAt: (connectionId: string) => number,
): Promise<{ live: boolean; swept: string[] }> {
  const spans = await readSpans();
  const now = Date.now();
  const previous = launch ? await previousOwner(spans) : null;
  const left = spans.filter(
    (s) => (previous !== null && s.owner === previous) || leftBehind(s, now),
  );
  for (const s of left) {
    const closed = bare(s);
    const since = generationAt(s.connectionId);
    await appendClosed(closed, undefined, since);
    // The mirror is written less often than the span is kept: its record of the book is
    // brought up to where the span ended (never back, never over a newer record).
    await mirrorSpanEnd(closed, since, spanSaysSomething(closed)).catch(() => undefined);
  }
  if (left.length > 0) {
    await writeSpans(spans.filter((s) => !left.includes(s)));
    notify(); // an offline span counted while stored is now an event
  }
  if (launch) {
    // Rotate only after recovery, so a second reload during the sweep can still finish it.
    try {
      ownerSession?.setItem(OWNER_KEY, tabId);
    } catch {
      // Storage unavailable: the usual stale-span sweep still applies.
    }
  }
  return {
    live: spans.some((s) => s.owner !== tabId && !left.includes(s)),
    swept: [...new Set(left.map((s) => s.connectionId))],
  };
}

/** Close the spans left behind (`closeLeftBehind`) and send what that put in the outbox:
 * the tab that left them is gone, so no send of its own follows (fe#211: the events waited
 * for this tab's next span to close). While another tab's live span is still stored, look
 * again once it would be stale. */
function sweepLeftBehind(launch = false): Promise<void> {
  const generations = captureConnectionGenerations();
  return spanOps(() => closeLeftBehind(launch, generations)).then(({ live, swept }) => {
    if (live) checkAgainLater();
    // Not waited for: a flush waits on the launch's recovery, which is this sweep. The web
    // only: the app's one sweep is its launch's, which sends every outbox next.
    if (Platform.OS === 'web' && sessionReady()) for (const cid of swept) void flushOutbox(cid);
  });
}

/** On the web, look again for spans left behind once another tab's live one would be stale. */
function checkAgainLater(): void {
  if (staleCheck) return;
  staleCheck = setTimeout(() => {
    staleCheck = null;
    sweepLeftBehind().catch(() => undefined);
  }, LIVE_SPAN_MS);
}

/**
 * Close a span a kill left open (a stored open span, at its last stored values) into the
 * outbox. Once per launch, before this launch's first span is written: every span write
 * waits on it. On the web a span another tab is still playing is left to it (looked at
 * again once it would be stale).
 */
export function recoverOpenSpan(): Promise<void> {
  recovery ??= sweepLeftBehind(true).catch((e: unknown) =>
    console.warn('[listening] could not recover the open span', e),
  );
  return recovery;
}

/** The span this tab stored last, to tell when another tab has taken it (`takenFrom`). */
let lastStored: OpenSpan | null = null;
/** The span this tab's keep moved to a new id (`goingOnFrom`), and the id it had: a keep or
 * a close of it still under that id (one already queued) goes as the new one. */
let wentOn: { from: string; span: OpenSpan } | null = null;

/** `span` under the id a keep moved it to (`wentOn`), else as it is. */
function asStored(span: OpenSpan): OpenSpan {
  if (!wentOn || wentOn.from !== span.id) return span;
  const { id, from, startedAt, start } = wentOn.span;
  return { ...span, id, from, startedAt, start };
}

/** The copy of `span` another tab took, else null: this tab's last stored copy of it is
 * gone from `spans` though no close of this tab cleared it. That tab found it left behind
 * (this tab's keeps stood still for `LIVE_SPAN_MS`: the computer slept, the tab was frozen)
 * and closed it into an event at the copy's values, under its id. */
function takenFrom(spans: StoredSpan[], span: OpenSpan): OpenSpan | null {
  if (!releaseSpanOwner || span.id === undefined || lastStored?.id !== span.id) return null;
  return spans.some((s) => s.owner === tabId) ? null : lastStored;
}

/** `span` going on from where the copy another tab closed ended (`taken`), as an event of
 * its own: under the copy's id, what played since would be answered `duplicate`. */
function goingOnFrom(span: OpenSpan, taken: OpenSpan): OpenSpan {
  return {
    ...span,
    id: newEventId(),
    from: taken.to,
    startedAt: taken.endedAt,
    start: 'continue',
  };
}

/** Keep the span being played (every few seconds while it plays; null clears it). Returns
 * the span as stored when it goes on under a new id (another tab took its last copy:
 * `takenFrom`), for the caller to play on with; else null. */
export async function storeOpenSpan(span: OpenSpan | null): Promise<OpenSpan | null> {
  await recoverOpenSpan();
  return spanOps(async () => {
    const spans = await readSpans();
    const current = span && asStored(span);
    const taken = current && takenFrom(spans, current);
    const kept = current && taken ? goingOnFrom(current, taken) : current;
    if (kept && taken && span?.id !== undefined) wentOn = { from: span.id, span: kept };
    const others = spans.filter((s) => s.owner !== tabId);
    await writeSpans(kept ? [...others, { ...kept, owner: tabId, keptAt: Date.now() }] : others);
    lastStored = kept;
    // The pending count changes only when a span comes or goes, not with each rewrite.
    const wasStored = !!releaseSpanOwner;
    if (kept) releaseSpanOwner ??= holdWebLock(spanOwnerLock(tabId));
    else clearSpanOwner();
    if (wasStored !== !!kept) notify();
    return taken ? kept : null;
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

/** Append `span`'s event, when it says something (on the base acknowledged by now), for
 * the sign-in `since` when given (`appendEvents`). */
async function appendClosed(
  span: OpenSpan,
  event?: ListeningSpanEvent,
  since?: number,
): Promise<void> {
  if (!spanSaysSomething(span)) return;
  const closed = event ?? spanToEvent({ ...span, baseVersion: await baseAtClose(span) });
  await appendEvents(span.connectionId, [closed], since);
}

/** Append `span`'s event (when it says something) and clear this tab's stored open span,
 * if any. Run inside `spanOps`. A span that went on under a new id (`wentOn`), or whose last
 * stored copy another tab took (`takenFrom`), closes as what played since. */
async function closeInto(
  span: OpenSpan,
  event?: ListeningSpanEvent,
  since?: number,
): Promise<void> {
  const current = asStored(span);
  const taken = releaseSpanOwner ? takenFrom(await readSpans(), current) : null;
  const closing = taken ? goingOnFrom(current, taken) : current;
  await appendClosed(closing, closing === span ? event : undefined, since);
  if (wentOn && (wentOn.from === span.id || wentOn.span.id === span.id)) wentOn = null;
  if (!releaseSpanOwner) return;
  await writeSpans((await readSpans()).filter((s) => s.owner !== tabId));
  clearSpanOwner();
  lastStored = null;
  notify();
}

/**
 * Close `span` into its `listen` event (when it says something, on the base acknowledged by
 * now: `baseAtClose`) and clear the stored open span. `event` is the span's event when the
 * caller made it already (the web's `pagehide` sends it at once).
 */
export async function closeSpan(span: OpenSpan, event?: ListeningSpanEvent): Promise<void> {
  const waiting = spanSaysSomething(span) ? [event ?? spanToEvent(span)] : [];
  // Signed out before its turn: the span is the removed sign-in's, never appended after it.
  await inTurn(span.connectionId, waiting, (since) => closeInto(span, event, since));
}

/** `appendInTurn` calls still waiting their turn, by connection (`waitingInTurn`). */
const appendsInTurn = new Map<string, number>();

/** Whether events appended in turn (`appendInTurn`) for `connectionId` still wait: a send
 * now would leave them for a second request, which their caller makes once they are in.
 * Not a close (`closeSpan`): the page's own going queues one that nothing sends after. */
export function waitingInTurn(connectionId: string): boolean {
  return appendsInTurn.has(connectionId);
}

/** Closes (`closeSpan`) and the events behind them (`appendInTurn`) still waiting their
 * turn, by event id, in the order they came. The web's `pagehide` sends them too: one queued
 * behind a lock may never run once the page is going (a `localStorage` lease waits on a
 * timer, which an unloading page never fires). */
const queued = new Map<string, OutboxEntry>();

/** This tab's stored open span (tests), else the first one stored. */
export async function storedOpenSpan(): Promise<OpenSpan | null> {
  const spans = await readSpans();
  const span = spans.find((s) => s.owner === tabId) ?? spans[0];
  return span ? bare(span) : null;
}

// --- Per-connection sync state ---------------------------------------------------------

/** The sync state's read-modify-writes, in this tab and across tabs (`tabLock`). */
const withStateLock = tabLock(SYNC_KEY);

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

/** Each connection's stored clock skew (`clockSkewMs`): the one reader of it, which
 * `progress-sync` asks for its merges and every resume lookup (`stored-skews.ts`, fe#211).
 * A read, so not under the state's lock (as `syncStateOf`): the document is written whole,
 * and the lock would hold a resume behind another tab's lease. */
async function storedClockSkews(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [cid, state] of Object.entries(await readState())) {
    const skew = isRecord(state) ? state.clockSkewMs : undefined;
    if (typeof skew === 'number' && Number.isFinite(skew)) out[cid] = skew;
  }
  return out;
}
provideStoredSkews(storedClockSkews);

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
 * Whether listening on `connectionId` is recorded as events: its server's `listening_sync`
 * as the query cache's `/server` holds it. That is the server's answer this launch, else
 * its last answer of an earlier one, kept on the device and seeded at launch
 * (`src/api/server-snapshots.ts`), so a cold launch that can't reach the server still
 * knows it (W2 F3: an offline cold launch once had only an empty query cache, read that as
 * "no", and saved the offline listening by PUT, last write wins, whole-book seconds, no
 * history). Unknown (never answered, or asked before the seed landed) counts as yes: an
 * event waits in the outbox until a server without the route answers 404 and a fresh
 * `/server` confirms it (`rollBack`), which turns the events into PUT saves. False (the
 * server said so, or it rolled back this launch): today's PUT progress + POST history,
 * unchanged.
 */
export function usesListeningSync(connectionId: string): boolean {
  if (rolledBack.has(connectionId)) return false;
  return cachedCapability(connectionId, 'listening_sync') ?? true;
}

/**
 * Whether a Stay on `connectionId` is sent as a `stay` span (row 9c-2, CROSS-REPO section 25
 * "Stay wins"): its server's `listening_stay` as the query cache's `/server` holds it (the
 * answer this launch, else the kept one). Unknown counts as no, unlike `usesListeningSync`: a
 * server without it refuses the start as `invalid`, so the Stay goes as a `jump` there.
 */
export function usesListeningStay(connectionId: string): boolean {
  return (
    usesListeningSync(connectionId) && cachedCapability(connectionId, 'listening_stay') === true
  );
}

/**
 * The events as `connectionId`'s server takes them now (pure but for the capability read): a
 * `stay` queued while its server had `listening_stay` goes as a `jump` once the flag is gone
 * (an older server's decoder refuses the start). The stored event is unchanged; its id is the
 * same, so the answer still matches it.
 */
function eventsForServer(connectionId: string, events: ListeningEvent[]): ListeningEvent[] {
  if (usesListeningStay(connectionId)) return events;
  return events.map((e) => stayAsJump(e) ?? e);
}

// --- Sending ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<void>>();
const flushAgain = new Set<string>();
const chunkSizes = new Map<string, number>();
/** Events whose request is out now from this tab, to the end of its answer (`sending`): a
 * withdrawal waits for it. Another tab's are read from the stored outbox (`OutboxEntry.out`). */
const sendingNow = new Map<string, Promise<unknown>>();
/** Events taken back here (`withdrawFinish`): a chunk read before still holding one drops
 * it. One another tab took back is gone from the stored outbox (`markOut`). */
const withdrawn = new Set<string>();
/** Finish events a request carried while their server looked reachable and that got no
 * answer: the request may have arrived and only its answer been lost, so the server may
 * hold them (`carried`). This launch's only (an Undo is a toast of the launch that
 * marked the book). Never forgotten on an answer: an answered finish has left the outbox, so
 * nothing reads its mark, and one put back after a failed edit still takes the edit. This
 * tab's own; on the web the stored entry says it too (`OutboxEntry.maybeReached`), for the
 * tab whose Undo it is. */
const maybeReached = new Set<string>();

/** Whether a request to `connectionId`'s server can be expected to leave this device: the
 * server is not marked down, and the browser is not offline (it sends nothing then). */
function looksReachable(connectionId: string): boolean {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  return isReachable(connectionId);
}

/** The finishes of `entries` whose request, leaving now, may reach their server. */
function finishesLeaving(entries: OutboxEntry[]): string[] {
  return entries
    .filter((e) => e.event.kind === 'finish' && looksReachable(e.connectionId))
    .map((e) => e.event.id);
}

/** What a gateway answers for a server it reached and then lost (no answer in time, or one
 * that broke off: the server may have stored the batch first): a proxy's 502 and 504,
 * Cloudflare's 520 and 524. A 503 or a 52x that never connected reached no server. */
const GATEWAY_LOST = new Set([502, 504, 520, 524]);

/**
 * Whether a send that failed with `e` got no answer from the server itself, which may have
 * taken the batch all the same: the request timed out, the connection dropped, a gateway
 * lost the server (`GATEWAY_LOST`), the answer could not be kept, or it could not be read
 * (an `ApiError` under 400: a 2xx whose body is not JSON, `readJson`). Any other HTTP error
 * is the server's answer, and a refused batch stores nothing.
 */
function gotNoAnswer(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status < 400 || GATEWAY_LOST.has(e.status);
}

/** How long a finish's `out` mark stands (`OutboxEntry.out`): past a request's 15 s
 * timeout and the read of its answer, so a mark that ran out was left by a tab that went
 * away with its request, never by one still waiting. */
const OUT_MARK_MS = 45_000;
/** How long the mark of a finish sent as the page goes stands (`sendOnPageHide`): the
 * request outlives the page and nobody may see its answer, so an Undo in another tab waits
 * this long for it to land before its edit (which a finish landing later would undo). */
export const PAGE_HIDE_MARK_MS = 5_000;
/** How often a withdrawal waiting on another tab's send looks again, when no change of the
 * stored outbox told it sooner. */
const OUT_POLL_MS = 200;

const NONE: ReadonlySet<string> = new Set();

/** The `out` marks of `entry` (none: no request carrying it is out, or a stored value that
 * is not marks). */
const marksOf = (entry: OutboxEntry): Record<string, number> =>
  isRecord(entry.out) ? entry.out : {};

/** The Web Lock a tab holds while a request of its carrying a finish is out
 * (`holdOutMark`): its `out` marks stand that long whatever their time says (`isOut`). */
const outLockName = (tab: string) => `audiosilo-out:${tab}`;

/** Hold this tab's `outLockName` until the returned release (shared by its requests out at
 * once). A hidden tab's timers are throttled, the request's timeout too: a request can be
 * out past `OUT_MARK_MS`, and an Undo that read its mark as run out took its edit while the
 * finish could still land after it. The browser frees a closed tab's lock. Nothing is held
 * without Web Locks (native, plain http): the time stands alone. A new `tabId` (tests) takes
 * a new one. */
let holdOutMark = sharedWebLock(outLockName(tabId));

/** Whether a request carrying `entry` is out (in any tab) by its stored marks: one whose time
 * stands, or whose tab holds its lock (`live`, the Web Locks held now; null where no tab can
 * tell). A mark that stands further ahead than any is written for (the clock set back since)
 * has run out too: read as live, an Undo would wait on it until the clock caught up. */
const isOut = (entry: OutboxEntry, now: number, live: ReadonlySet<string> | null = null) =>
  Object.entries(marksOf(entry)).some(
    ([tab, until]) =>
      (until > now && until - now <= OUT_MARK_MS) || live?.has(outLockName(tab)) === true,
  );

/** `entry` marked as out from this tab until `until` (beside any other tab's mark). */
const markedOut = (entry: OutboxEntry, until: number): OutboxEntry => ({
  ...entry,
  out: { ...marksOf(entry), [tabId]: until },
});

/**
 * Before a request that carries finishes (`ids`), on the web: under the outbox's lock, the
 * ones no longer stored are found (taken back by an Undo in another tab, or answered
 * there; returned, and not sent), and the rest are marked as out in the stored outbox
 * (`OutboxEntry.out`), where a withdrawal in any tab reads it. The lock orders the two: a
 * withdrawal either took the finish back first, or finds it out and waits.
 */
function markOut(ids: string[]): Promise<ReadonlySet<string>> {
  return withOutboxLock(async () => {
    const queue = await readOutbox();
    const stored = new Set(queue.map((e) => e.event.id));
    const gone = new Set(ids.filter((id) => !stored.has(id)));
    if (gone.size < ids.length) {
      const until = Date.now() + OUT_MARK_MS;
      await writeOutbox(queue.map((e) => (ids.includes(e.event.id) ? markedOut(e, until) : e)));
    }
    return gone;
  }).catch(() => NONE);
}

/**
 * After that request: this tab's `out` marks come off the finishes still stored (an
 * answered one has left the outbox), and the ones the request carried with no answer
 * (`lost`) are marked `maybeReached`, in one write, so a withdrawal that waited never reads
 * a finish as neither.
 */
function markSettled(ids: string[], lost: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return withOutboxLock(async () => {
    const queue = await readOutbox();
    let changed = false;
    const next = queue.map((entry): OutboxEntry => {
      if (!ids.includes(entry.event.id)) return entry;
      const marks = marksOf(entry);
      const reached = lost.includes(entry.event.id) && !entry.maybeReached;
      if (!(tabId in marks) && !reached) return entry;
      changed = true;
      const { out: _out, ...unmarked } = entry;
      const { [tabId]: _mine, ...others } = marks;
      return {
        ...unmarked,
        ...(Object.keys(others).length > 0 ? { out: others } : {}),
        ...(reached ? { maybeReached: true } : {}),
      };
    });
    if (changed) await writeOutbox(next);
  }).catch(() => undefined);
}

/**
 * The events of `chunk` still to go (not taken back meanwhile), marked as out while `send`
 * runs: in this tab's memory (`sendingNow`) and, for a finish on the web, in the stored
 * outbox (`markOut`), so a withdrawal in this tab or another either took an event back
 * first or finds it out and waits. The memory mark is set with no wait after the last
 * check of `withdrawn`.
 */
async function sending<T>(
  chunk: OutboxEntry[],
  send: (live: OutboxEntry[]) => Promise<T>,
): Promise<T> {
  const marked = sharedAcrossTabs()
    ? chunk.filter((e) => e.event.kind === 'finish').map((e) => e.event.id)
    : [];
  // Asked before the mark is written, held until it is taken off.
  const releaseOut = marked.length > 0 ? holdOutMark() : () => {};
  const gone = marked.length > 0 ? await markOut(marked) : NONE;
  const live = chunk.filter((e) => !withdrawn.has(e.event.id) && !gone.has(e.event.id));
  const leaving = finishesLeaving(live);
  const run = send(live);
  // Settled once its marks are: a withdrawal that waited reads them next.
  const settled = run
    .then(
      () => [],
      (e: unknown) => (gotNoAnswer(e) ? leaving : []),
    )
    .then((lost) => {
      for (const id of lost) maybeReached.add(id);
      return markSettled(marked, lost);
    });
  const release = markSending(live, settled);
  try {
    return await run;
  } finally {
    await settled;
    release();
    releaseOut();
  }
}

/** Mark `entries` out from this tab until `settled` (`sendingNow`); returns the release
 * (called once `settled` has), which clears only the marks still this request's. An entry
 * another request still carries (a flush's as the page hides, the keepalive's as a flush
 * follows) stays out until both have ended: released with the first, a withdrawal took a
 * finish back from under the other, which could then land it after the Undo's edit. */
function markSending(entries: OutboxEntry[], settled: Promise<unknown>): () => void {
  const marks = entries.map((e) => {
    const other = sendingNow.get(e.event.id);
    const mark = other ? Promise.allSettled([other, settled]) : settled;
    sendingNow.set(e.event.id, mark);
    return [e.event.id, mark] as const;
  });
  return () => {
    for (const [id, mark] of marks) {
      const clear = () => {
        if (sendingNow.get(id) === mark) sendingNow.delete(id);
      };
      if (mark === settled) clear();
      else void mark.then(clear);
    }
  };
}

/** Resolves at the next change of the outbox (this tab's write, or another tab's through
 * the `storage` event), or after `ms`. */
function outboxChanged(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = onOutboxChange(done);
  });
}

/** What `withdrawFinish` took back. */
export type Withdrawal = {
  /** A finish that never reached the server was taken back (an offline Mark as finished),
   * so the Undo is complete here, with no progress edit. Never true while the server may
   * hold the finish (`carried`): the Undo then takes its edit. */
  unsent: boolean;
  /** Nothing was taken back: a request carried the finish with no answer, so the server may
   * hold it, and its server looks down now, so no edit can undo it there. The Undo fails
   * (fe#258): done on this device alone, the book stayed finished on a server that had it,
   * which then won on reconnect. */
  unreachable?: true;
  /** For an edit that failed: the events go back where they were and are sent. */
  restore: () => Promise<void>;
};

/** Whether a request carried the finish `entry` with no answer (`maybeReached`, this tab's
 * or the stored mark), or an `out` mark on it ran out (a live one is waited for): the tab
 * that sent it went with its request. The server may hold it. */
function carried(entry: OutboxEntry): boolean {
  return maybeReached.has(entry.event.id) || !!entry.maybeReached || !!entry.out;
}

/** A finish taken back, and the events that were ahead of it then (where it goes back to). */
type Taken = { entry: OutboxEntry; after: ReadonlySet<string> };

/**
 * Take a book's waiting `finish` events out of the outbox, before an Undo's progress edit
 * (fe#208): a finish sent after the edit would finish the book again. One whose request is
 * out is waited for (answered, the server has it and the edit comes after it; unanswered,
 * it is taken back). Rejects, taking nothing, when storage would not hold the removal: the
 * finish would be sent after a restart, over the edit.
 *
 * Across the tabs of the web player the same holds through the stored outbox, which every
 * tab reads under its lock (fe#123): a send in another tab marked the finish as out there
 * first (`markOut`) and is waited for by that mark, a send that comes after the withdrawal
 * finds the finish gone and leaves it out of its request, and what another tab's request
 * carried with no answer is read from its `maybeReached` mark.
 *
 * A finish taken back counts as unsent only when no request carried it with no answer
 * (`carried`). One that a request did carry may be on the server: with its server
 * reachable the edit unfinishes the book whether the request arrived or not, and a failed
 * edit puts the finish back (`restore`; sent again it is a `duplicate` when the server had
 * it); with its server down nothing is taken back and the Undo fails (`unreachable`).
 */
export async function withdrawFinish(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<Withdrawal> {
  // The sign-in the finish belongs to: one signed out meanwhile gets nothing put back.
  const since = connectionGeneration(connectionId);
  const isMine = (e: OutboxEntry) =>
    e.connectionId === connectionId &&
    e.event.kind === 'finish' &&
    e.event.library_id === libraryId &&
    e.event.path === path;
  const taken: Taken[] = [];
  // The finishes waited for: one not taken back after was answered (the server has it).
  const waitedFor = new Set<string>();
  for (;;) {
    const wait = await withOutboxLock(async () => {
      const queue = await readOutbox();
      const mine = queue.filter(isMine);
      const now = Date.now();
      // Asked only when a mark is there to read.
      const live = mine.some((e) => e.out) ? await queryWebLocks() : null;
      // Out from this tab (its request's own end is waited for), or by the stored mark
      // from another tab, whose answer shows as a change of the stored outbox.
      const out = mine.filter((e) => sendingNow.has(e.event.id) || isOut(e, now, live));
      if (out.length > 0) {
        for (const e of out) waitedFor.add(e.event.id);
        const here = out.find((e) => sendingNow.has(e.event.id));
        // Boxed: a promise returned as is would hold the lock until it settles (its answer
        // needs the lock).
        return { out: here ? sendingNow.get(here.event.id) : outboxChanged(OUT_POLL_MS) };
      }
      if (mine.some(carried) && !looksReachable(connectionId)) return { down: true as const };
      if (mine.length === 0) return null;
      // Before the write: a send that read the outbox before this leaves them out.
      for (const e of mine) withdrawn.add(e.event.id);
      if (!(await writeOutbox(queue.filter((e) => !isMine(e))))) {
        for (const e of mine) withdrawn.delete(e.event.id);
        await writeOutbox(queue);
        throw new Error('the outbox could not store the withdrawal');
      }
      for (const entry of mine) {
        const at = queue.indexOf(entry);
        taken.push({ entry, after: new Set(queue.slice(0, at).map((e) => e.event.id)) });
      }
      return null;
    });
    if (!wait) break;
    if ('down' in wait) {
      return { unsent: false, unreachable: true, restore: () => Promise.resolve() };
    }
    await wait.out;
  }
  const answered = [...waitedFor].some((id) => !taken.some((t) => t.entry.event.id === id));
  // One a request carried may be on the server, which looked reachable as it was taken
  // (else nothing was: `unreachable`), so the Undo takes its edit. Not asked again here: the
  // server marked down since, the Undo was done on this device alone (fe#258).
  const held = taken.some((t) => carried(t.entry));
  return {
    unsent: taken.length > 0 && !answered && !held,
    restore: async () => {
      if (taken.length === 0) return;
      for (const t of taken) withdrawn.delete(t.entry.event.id);
      const after = new Map(taken.map((t) => [t.entry.event.id, t.after]));
      // Back where it was, ahead of what came after it then and since (listens made after
      // the Mark, an unfinish and a restart): put back at the end it finished the book
      // again over them. Without a send's mark; what the server may hold stays marked for
      // every tab.
      await appendEntries(
        taken.map(({ entry: { event, maybeReached: reached, out } }) => ({
          connectionId,
          event,
          ...(reached || out ? { maybeReached: true as const } : {}),
        })),
        since,
        (queue, entry) => {
          const ahead = after.get(entry.event.id) ?? new Set<string>();
          return queue.findIndex((e) => !ahead.has(e.event.id));
        },
      );
      void flushOutbox(connectionId);
    },
  };
}

/** Connections making their last send (`flushOutbox`'s `lastChance`), under their id now
 * (`resolveConnectionId`), by how many such calls are still out: a flush already running for
 * another caller goes round again under it, and one call ending never takes the bypass from
 * another still waiting (a removal asked twice, a flush begun just as the first ended). */
const lastChance = new Map<string, number>();

/** Flush `connectionId`'s outbox and every other id its waiting events are stored under: one
 * the identity migration moved it from (`sameConnection`, as the legacy queue's last send
 * routes its saves), each flushed under the id it names. */
async function flushEveryId(connectionId: string): Promise<void> {
  const queue = await outboxEvents().catch((): OutboxEntry[] => []);
  const ids = new Set([connectionId]);
  for (const e of queue) if (sameConnection(e.connectionId, connectionId)) ids.add(e.connectionId);
  await Promise.all([...ids].map((cid) => flushOutbox(cid)));
}

/**
 * Send a connection's outbox. One flush at a time per connection: a call while one runs
 * makes it go round once more when it ends (a sync that left more goes on by itself).
 * `lastChance`: the connection's sign-out or removal is making its last send, which tries
 * the events whatever wait its server asked (a 429), as the legacy queue's does
 * (`onlyConnection`), those under an id the identity migration moved it from too: the purge
 * after it drops what is left, under either id (`onConnectionRemoved`).
 */
export function flushOutbox(
  connectionId: string,
  opts: { lastChance?: boolean } = {},
): Promise<void> {
  if (opts.lastChance) {
    const id = resolveConnectionId(connectionId);
    lastChance.set(id, (lastChance.get(id) ?? 0) + 1);
    return flushEveryId(connectionId).finally(() => {
      const left = (lastChance.get(id) ?? 1) - 1;
      if (left > 0) lastChance.set(id, left);
      else lastChance.delete(id);
    });
  }
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

/**
 * Listens refused `duration_mismatch` because they were played over a download that ends
 * before its book does (D3): before 8d such a queue sent the downloaded part's length, more
 * than 10 s off the server's book, so the listening never reached it. Each goes back into the
 * outbox at the book's length on its server (`downloadBookLength`), or with no length when
 * that is not known (the server then checks none, as a partial queue's span now sends), and
 * leaves the couldn't-sync list. Only a listen whose length would change: one refused again
 * at that length (another edition indeed) stays on the list.
 */
export async function resendMismatched(): Promise<void> {
  const state = await readState();
  const now = Date.now();
  for (const [connectionId, s] of Object.entries(state)) {
    const again: ListeningSpanEvent[] = [];
    for (const f of s.failed ?? []) {
      if (!stillKept(f, now) || f.reason !== 'duration_mismatch' || f.event.kind !== 'listen')
        continue;
      const length = await downloadBookLength(connectionId, f.event.library_id, f.event.path);
      if (length === undefined) continue;
      const { duration: _was, ...rest } = f.event;
      const event: ListeningSpanEvent = length > 0 ? { ...rest, duration: length } : rest;
      if (event.duration !== f.event.duration) again.push(event);
    }
    if (again.length === 0) continue;
    // Queued before it leaves the list: a stop in between leaves it on both (sent again
    // by id, a replay the server answers duplicate), never on neither.
    await appendEvents(connectionId, again);
    // The refused copy only: one refused again meanwhile (at the new length) stays.
    const sent = new Map(again.map((e) => [e.id, e.duration]));
    await updateState(connectionId, (st) => ({
      ...st,
      failed: (st.failed ?? []).filter(
        (f) =>
          !sent.has(f.event.id) ||
          (f.event.kind === 'listen' && sent.get(f.event.id) === f.event.duration),
      ),
    }));
  }
}

/** Send every connection's outbox (a launch, the foreground). */
export async function flushAllOutboxes(): Promise<void> {
  if (!sessionReady()) return;
  const recovered = recovery !== null;
  await recoverOpenSpan();
  await resendMismatched().catch(() => undefined);
  // The web: another tab's span may have been left since (that tab closed or crashed). The
  // launch's first call has just looked (the recovery).
  if (Platform.OS === 'web' && recovered) await sweepLeftBehind().catch(() => undefined);
  const ids = new Set((await currentOutbox()).map((e) => e.connectionId));
  await Promise.all([...ids].map((cid) => flushOutbox(cid)));
}

/**
 * What hasn't reached `connectionId`'s server, after a last send while it is reachable
 * (sign-out and removing a server confirm when any is left): its events, a waiting finish
 * or unfinish too, since removal drops them all. A span another tab left (closed before its
 * close landed) goes into the outbox first, so it is sent or counted, not dropped unseen.
 * So does the span playing through it (`cutPlayingSpan`, a span opening where it ended).
 */
export async function unsentListens(connectionId: string): Promise<number> {
  await sweepLeftBehind().catch(() => undefined);
  cutPlayingSpan(connectionId);
  // Behind its close's turn (`closeSpan`), as a sign-out's stop waits it out.
  await appendInTurn(connectionId, []).catch(() => undefined);
  if (isReachable(connectionId)) await flushOutbox(connectionId, { lastChance: true });
  return (await pendingSaves(connectionId)).events;
}

/** A batch's envelope with this attempt's clock, its events as the server takes them now
 * (`eventsForServer`). */
function syncBody(connectionId: string, events: ListeningEvent[], deviceId: string) {
  return {
    device_id: deviceId,
    sent_at: new Date().toISOString(),
    events: eventsForServer(connectionId, events),
  };
}

/** How many rounds one flush makes at most (a 500-event backlog in chunks of 200 is 3). */
const MAX_ROUNDS = 50;

async function flushOnce(connectionId: string): Promise<void> {
  if (!sessionReady()) return;
  await recoverOpenSpan();
  // The server asked to wait (a 429 until its `Retry-After`): the events stay, and go once
  // the wait is over (`onRateLimitOver`, below). Not a sign-out's last chance.
  if (rateLimited(connectionId) && !lastChance.has(resolveConnectionId(connectionId))) return;
  // Read again at each round's send (`liveClient`): a re-pair during the flush changes the
  // token, and a round sent with the old one is refused (401).
  const client = liveClient(connectionId);
  // A connection gone: its events are purged with it (`onConnectionRemoved`).
  if (!client) return;
  await giveUpOld(connectionId);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const pending = await outboxEvents(connectionId);
    if (pending.length === 0) return;
    const chunk = pending.slice(0, chunkSizes.get(connectionId) ?? MAX_CHUNK);
    if ((await sendChunk(connectionId, client, chunk)) === 'stop') return;
  }
}

/** When an event happened (its end), ms. */
function eventTime(event: ListeningEvent): number {
  return Date.parse(event.kind === 'listen' ? event.ended_at : event.at);
}

/**
 * Move a connection's events older than `GIVE_UP_AGE_MS` to the couldn't-sync list
 * (`too_old`, the server's own reason): never answered (a server that kept failing, or
 * gone that long), they could only wait on, keeping their book pending (fe#208).
 */
async function giveUpOld(connectionId: string, now = Date.now()): Promise<void> {
  const old = (await outboxEvents(connectionId)).filter(
    (e) => now - eventTime(e.event) > GIVE_UP_AGE_MS,
  );
  await moveToFailed(
    connectionId,
    old.map((e) => ({ event: e.event, reason: 'too_old' })),
  );
}

/** What one request's outcome asks of the flush. */
type Next = 'more' | 'stop';

/**
 * The server took a sync request, so it has the route: a kept `/server` that says otherwise
 * (an older answer, from before the server was updated) takes the flag now, and a rollback
 * earlier this launch (the server since updated) no longer holds. For a batch and for an
 * event sent alone (a batch refused as a whole, its events then taken one by one).
 */
function tookSync(connectionId: string): void {
  noteSuccess(connectionId);
  rolledBack.delete(connectionId);
  if (cachedCapability(connectionId, 'listening_sync') === false) {
    keepServerFlag(connectionId, 'listening_sync');
  }
}

async function sendChunk(
  connectionId: string,
  client: ApiClient,
  chunk: OutboxEntry[],
): Promise<Next> {
  const since = connectionGeneration(connectionId);
  let attempted = chunk;
  try {
    const deviceId = await getDeviceId();
    return await sending<Next>(chunk, async (live) => {
      attempted = live;
      if (live.length === 0) return 'more';
      const sentAt = Date.now();
      const body = syncBody(
        connectionId,
        live.map((e) => e.event),
        deviceId,
      );
      const answer = await client.syncListening(body);
      tookSync(connectionId);
      await applyAnswer(connectionId, live, body.events, answer, {
        sentAt,
        answeredAt: Date.now(),
      });
      return 'more';
    });
  } catch (e) {
    if (!(e instanceof ApiError)) {
      // No answer: keep everything; only a check marks the server down.
      noteFailure(connectionId, e);
      return 'stop';
    }
    if (e.status === 404 || e.status === 405) {
      if (connectionGeneration(connectionId) === since) await rollBack(connectionId, client, since);
      return 'stop';
    }
    if (e.status === 413 || e.code === 'too_many_events') {
      if (attempted.length > 1) {
        chunkSizes.set(connectionId, Math.max(1, Math.floor(attempted.length / 2)));
        return 'more';
      }
      // One event alone is still too big: the server can never take it.
      await moveToFailed(connectionId, [{ event: attempted[0].event, reason: 'too_large' }]);
      return 'more';
    }
    if (e.status === 400) return sendOneByOne(connectionId, client, attempted);
    // A 429 (the rate limit) is the connection's: its flushes, and the legacy queue's
    // replays and live saves, wait out its `Retry-After` (`rateLimited`). 401 (the client
    // has flagged the sign-in), 403, 5xx: keep them for a later try.
    noteRateLimit(connectionId, e);
    return 'stop';
  }
}

// A wait the server asked for (a 429) is over, or a proxy's refusals of the connection ended
// (`onProxyRefusalsOver`): the events they held go now, not at the next replay. Told the
// connection's id now (`resolveConnectionId`), which held the events of an id the identity
// migration moved it from too: those go as well, under the id they name.
const sendHeld = (connectionId: string) => void flushEveryId(connectionId).catch(() => undefined);
onRateLimitOver(sendHeld);
onProxyRefusalsOver(sendHeld);

/** A 400 on a batch: each event alone, once; one still refused alone can never be sent,
 * but a `stay` (a server rolled back under a stale cached `listening_stay`, whose decoder
 * refuses the start) goes once more as the `jump` every server takes (fe#321). */
async function sendOneByOne(
  connectionId: string,
  client: ApiClient,
  chunk: OutboxEntry[],
): Promise<Next> {
  let flagAsked = false;
  for (const entry of chunk) {
    // A batch of one was that event alone already.
    let sent = chunk.length === 1 ? 'refused' : await sendAlone(connectionId, client, entry);
    const jump = sent === 'refused' ? stayAsJump(entry.event) : null;
    if (jump) {
      // The cached flag said yes: it is asked again (once), so the next Stay goes as a `jump`.
      if (!flagAsked) void queryClient.invalidateQueries({ queryKey: qk.server(connectionId) });
      flagAsked = true;
      sent = await sendAlone(connectionId, client, { ...entry, event: jump });
    }
    if (sent === 'stop') return 'stop';
    if (sent === 'refused') {
      await moveToFailed(connectionId, [{ event: entry.event, reason: 'invalid' }]);
    }
  }
  return 'more';
}

/** A `stay` as a `jump` (the same id, so the answer still matches the stored event), else
 * null. */
function stayAsJump(event: ListeningEvent): ListeningEvent | null {
  return event.kind === 'listen' && event.start === 'stay' ? { ...event, start: 'jump' } : null;
}

/** Send one entry alone: `refused` on a 400, `stop` on no answer or another error. */
async function sendAlone(
  connectionId: string,
  client: ApiClient,
  entry: OutboxEntry,
): Promise<'sent' | 'refused' | 'stop'> {
  try {
    const deviceId = await getDeviceId();
    await sending([entry], async (live) => {
      if (live.length === 0) return;
      const body = syncBody(connectionId, [entry.event], deviceId);
      const answer = await client.syncListening(body);
      tookSync(connectionId);
      await applyAnswer(connectionId, [entry], body.events, answer);
    });
    return 'sent';
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) return 'refused';
    if (!(e instanceof ApiError)) noteFailure(connectionId, e);
    noteRateLimit(connectionId, e);
    return 'stop';
  }
}

/** A book whose stored place the server kept over a listen or an explicit Stay from here. */
export type HeldListen = 'listen' | 'stay';
/** Told of every sync answer's rows and which books' listens they held. */
type AnswerListener = (
  connectionId: string,
  rows: Progress[],
  held: ReadonlyMap<string, HeldListen>,
) => void;
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

/**
 * Books whose stored place the server kept over a listen in this request. A resume or
 * continue behind an unseen row can come back `resume_behind` instead of diverged. A
 * held Stay takes precedence over another held span of the same book in the batch.
 */
export function heldListens(
  connectionId: string,
  sent: ListeningEvent[],
  results: Map<string, ListeningSyncResult>,
): Map<string, HeldListen> {
  const held = new Map<string, HeldListen>();
  for (const e of sent) {
    const r = results.get(e.id);
    if (e.kind !== 'listen' || !r) continue;
    const heldHere =
      (r.status === 'diverged' && r.kept === 'stored') ||
      (r.status === 'not_applied' && r.reason === 'resume_behind');
    if (!heldHere) continue;
    const key = contentKey(connectionId, e.library_id, e.path);
    if (held.get(key) !== 'stay') held.set(key, e.start === 'stay' ? 'stay' : 'listen');
  }
  return held;
}

/**
 * How far ahead of this device's clock the server's was, from an answer's `server_time`
 * and when the request went and its answer came (the middle of the two; pure). Undefined
 * when the answer carries no readable time.
 */
export function clockSkewOf(
  serverTime: string | undefined,
  sentAt: number,
  answeredAt: number,
): number | undefined {
  const server = serverTime ? Date.parse(serverTime) : Number.NaN;
  if (!Number.isFinite(server)) return undefined;
  return Math.round(server - (sentAt + answeredAt) / 2);
}

async function applyAnswer(
  connectionId: string,
  sent: OutboxEntry[],
  events: ListeningEvent[],
  answer: ListeningSyncResponse,
  timing?: { sentAt: number; answeredAt: number },
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
  const skew = timing && clockSkewOf(answer.server_time, timing.sentAt, timing.answeredAt);
  if (skew !== undefined) noteClockSkew(connectionId, skew);
  await updateState(connectionId, (s) => ({
    ...s,
    lastSyncAt: new Date().toISOString(),
    ...(skew !== undefined ? { clockSkewMs: skew } : {}),
  }));

  const rows = answer.progress ?? [];
  const deviceId = await getDeviceId();
  for (const row of rows) {
    if (keptMine(row, deviceId, events, results)) {
      // A mirror that could not be read is left as it is (`updateMirror` rejects); the rest
      // of the answer still lands.
      await ackVersion(connectionId, row.library_id, row.path, row.version, row).catch(
        () => undefined,
      );
    }
    // The book's cached progress is the place Resume plays (`bookPlace`, fe#211), as its
    // own read answers (`fetchBookProgress`): a row the server kept over this device's
    // newer place (another device's, further on) must not show while Resume plays here.
    const place = await bookPlace(row, connectionId, row.library_id, row.path).catch(() => null);
    queryClient.setQueryData(qk.progress(connectionId, row.library_id, row.path), place ?? row);
  }
  if (events.some((e) => e.kind === 'listen')) {
    void queryClient.invalidateQueries({ queryKey: qk.historyAll(connectionId) });
  }
  // As sent: a `stay` that went as a `jump` (the flag gone) was held by the usual rule.
  const held = heldListens(connectionId, events, results);
  for (const listener of answerListeners) listener(connectionId, rows, held);
}

// --- The rollback ----------------------------------------------------------------------

/**
 * One book's events as a legacy save. A cut continues at the preceding span's end.
 * It carries a deliberate move through that play, even if the spans were appended out of order.
 */
export function legacySaveOf(entries: OutboxEntry[], deviceId: string): ProgressSave | null {
  let listen: ListeningSpanEvent | undefined;
  let chosen = false;
  let state: ListeningFinishEvent | undefined;
  const ordered = [...entries].sort((a, b) => eventTime(a.event) - eventTime(b.event));
  for (const { event } of ordered) {
    if (event.kind === 'listen') {
      chosen =
        event.start === 'continue'
          ? chosen && listen?.to_pos === event.from_pos && listen.to_file === event.from_file
          : MOVE_STARTS.has(event.start);
      listen = event;
    } else {
      state = event;
    }
  }
  const ref = listen ?? state;
  if (!ref) return null;
  const finished = state?.kind === 'finish' && (!listen || state.at >= listen.ended_at);
  const duration = listen?.duration ?? 0;
  const listenedAt = listen?.ended_at ?? '';
  const at = state && state.at > listenedAt ? state.at : listenedAt;
  const position = finished && duration > 0 ? duration : (listen?.to_pos ?? 0);
  if (!at && !finished && !(position > 0)) return null;
  return {
    connectionId: entries[0].connectionId,
    libraryId: ref.library_id,
    path: ref.path,
    position,
    duration,
    finished,
    playback_speed: listen?.playback_speed ?? 1,
    device_id: deviceId,
    updated_at: at,
    ...(!finished && !chosen ? { guard: true } : {}),
  };
}

/**
 * A finish with no listen beside it (Mark as finished, fe#208) has no place or length in the
 * outbox: it takes them from this device's mirror, which the finish wrote (`finishedSave`),
 * so the PUT is the one the legacy path sends (finished at the book's end, its real
 * duration), never a finish at 0 of 0.
 */
async function withFinishedPlace(save: ProgressSave): Promise<ProgressSave> {
  if (!save.finished || save.duration > 0) return save;
  const mirror = await readMirror(save.connectionId, save.libraryId, save.path).catch(() => null);
  if (!mirror?.finished || !(mirror.duration > 0)) return save;
  return {
    ...save,
    position: mirror.position > 0 ? mirror.position : mirror.duration,
    duration: mirror.duration,
    playback_speed: mirror.playback_speed > 0 ? mirror.playback_speed : save.playback_speed,
  };
}

/** Drop a connection's events from the outbox, those under an id the identity migration
 * moved it from too (`sameConnection`, as its last send takes them); returns them. */
function takeConnection(connectionId: string): Promise<OutboxEntry[]> {
  const ofIt = (e: OutboxEntry) => sameConnection(e.connectionId, connectionId);
  return withOutboxLock(async () => {
    const queue = await readOutbox();
    const mine = queue.filter(ofIt);
    if (mine.length > 0) await writeOutbox(queue.filter((e) => !ofIt(e)));
    return mine;
  });
}

/**
 * A 404/405 on the sync route: rolled back only when the server says so, its `/server`
 * answering without `listening_sync` (anything else answering at the address, a home
 * address another host holds on this network, keeps the outbox for a later send). The
 * events go as legacy saves, then leave the outbox (a kill between sends them again).
 * The replay guard checks an ordinary listen against another device's further place.
 * A held save transfers to the legacy queue before the original events leave the outbox.
 */
async function rollBack(connectionId: string, client: ApiClient, since: number): Promise<void> {
  const info = await client.serverInfo().catch(() => null);
  if (!info || info.capabilities?.listening_sync || connectionGeneration(connectionId) !== since)
    return;
  // Its answer is the connection's `/server` from now on, kept for the next launch too;
  // another server's (a reset one), or one from an address the connection has left, is no
  // answer about this connection's route.
  if (!keepServerAnswer(connectionId, info, client.baseUrl)) return;
  rolledBack.add(connectionId);
  const mine = await outboxEvents(connectionId);
  const deviceId = await getDeviceId();
  const books = new Map<string, OutboxEntry[]>();
  for (const entry of mine) {
    const key = contentKey(connectionId, entry.event.library_id, entry.event.path);
    const group = books.get(key);
    if (group) group.push(entry);
    else books.set(key, [entry]);
  }
  // Mark only the book about to be PUT. A later book's finish can still be withdrawn
  // while earlier PUTs are out, and sending rechecks it before computing that book's save.
  for (const entries of books.values()) {
    await sending(entries, async (live) => {
      const save = legacySaveOf(live, deviceId);
      if (save) {
        const place = await withFinishedPlace(save);
        if (connectionGeneration(connectionId) !== since) return;
        await saveProgress(client, place, { requireQueued: true });
      }
      if (connectionGeneration(connectionId) !== since) return;
      await removeEvents(new Set(live.map((e) => e.event.id)));
    });
  }
}

// --- The web page going ------------------------------------------------------------------

/**
 * Web `pagehide`: send what waits (the outbox, the closes and the events behind them still
 * queued: `queued`; plus `extra`, the span closed this moment) in one
 * keepalive request per connection, as much as fits in `KEEPALIVE_BYTES`. Synchronous up to
 * the requests (the page is going); an answer that still arrives is applied as usual, and
 * anything unanswered stays in the outbox (a resend is a `duplicate`).
 */
export function sendOnPageHide(extra: OutboxEntry[], deviceId: string): void {
  if (!sessionReady()) return;
  const byConnection = new Map<string, OutboxEntry[]>();
  const seen = new Set<string>();
  const waiting = [...(outboxCache ?? []), ...queued.values(), ...extra];
  // Read for a finish only: nothing else is checked against it or marked in it.
  const stored = waiting.some((e) => e.event.kind === 'finish') ? storedOutboxNow() : null;
  const storedIds = stored && new Set(stored.entries.map((e) => e.event.id));
  for (const entry of waiting) {
    if (seen.has(entry.event.id)) continue;
    // A finish another tab took back a moment ago (its Undo), before this tab's copy heard.
    // Not one still waiting its turn here (`queued`): it was never stored to be taken back.
    if (
      entry.event.kind === 'finish' &&
      storedIds &&
      !storedIds.has(entry.event.id) &&
      !queued.has(entry.event.id)
    ) {
      continue;
    }
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
    // Its answer may never be seen (the page is going): the server may hold these.
    const leaving = finishesLeaving(fit);
    for (const id of leaving) maybeReached.add(id);
    if (stored && leaving.length > 0) markOutNow(stored.storage, leaving);
    const body = syncBody(
      cid,
      fit.map((e) => e.event),
      deviceId,
    );
    const settled = client
      .syncListening(body, { keepalive: true })
      .then((answer) => applyAnswer(cid, fit, body.events, answer))
      .catch(() => undefined);
    // Out from this tab until it ends, as a flush's request is (`sending`): a page that
    // was only hidden comes back (the back-forward cache) with the request still out, and
    // an Undo then waits for its answer rather than taking the finish back from under it.
    void settled.then(markSending(fit, settled));
  }
}

/** What `storedOutboxNow` read: the web's `localStorage` and the outbox in it. */
type StoredNow = { storage: Pick<Storage, 'getItem' | 'setItem'>; entries: OutboxEntry[] };

/**
 * The stored outbox, read without a wait: the web's `localStorage` (where the web's storage
 * keeps it, under the key as it is), for a page that is going, where no lock can be waited
 * for and no promise runs on. Null off the web, and while this tab's copy is not the stored
 * one (never read, or holding a write storage refused).
 */
function storedOutboxNow(): StoredNow | null {
  if (Platform.OS !== 'web' || !outboxRead || outboxUnsaved) return null;
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return null;
    return { storage, entries: parseOutbox(storage.getItem(OUTBOX_KEY)) };
  } catch {
    return null;
  }
}

/**
 * Mark the finishes `ids` as out in the stored outbox, as the page goes: for
 * `PAGE_HIDE_MARK_MS`, with nobody to take the mark off, so an Undo in another tab waits
 * that long for the request to land, then reads the mark left standing as "the server may
 * hold it" and sends its edit. Written outside the outbox's lock (a page that is going
 * cannot wait for one), so the outbox is read again here, with nothing between the read and
 * the write: another tab's write that landed since the page began to go (an event it
 * appended) is kept, not written over from the older read. A write another tab makes from
 * an older read of its own can only lose the mark again.
 */
function markOutNow(storage: StoredNow['storage'], ids: string[]): void {
  try {
    const entries = parseOutbox(storage.getItem(OUTBOX_KEY));
    if (!entries.some((e) => ids.includes(e.event.id))) return;
    const until = Date.now() + PAGE_HIDE_MARK_MS;
    const next = entries.map((e) => (ids.includes(e.event.id) ? markedOut(e, until) : e));
    storage.setItem(OUTBOX_KEY, JSON.stringify(next));
    outboxCache = next;
  } catch {
    // Storage refuses the read or the write: the mark is this tab's memory only.
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
      const spans = await readSpans();
      const kept = spans.filter((s) => s.connectionId !== id);
      if (kept.length === spans.length) return;
      await writeSpans(kept);
      if (!kept.some((s) => s.owner === tabId)) clearSpanOwner();
    }),
    updateState(id, () => null),
  ]);
});

/** Test-only: forget what this module holds in memory. */
export function resetOutboxForTests(): void {
  outboxCache = null;
  outboxRead = false;
  outboxUnsaved = false;
  recovery = null;
  clearSpanOwner();
  lastStored = null;
  wentOn = null;
  queued.clear();
  appendsInTurn.clear();
  tabId = randomUUID();
  holdOutMark = sharedWebLock(outLockName(tabId));
  if (staleCheck) clearTimeout(staleCheck);
  staleCheck = null;
  rolledBack.clear();
  chunkSizes.clear();
  sendingNow.clear();
  withdrawn.clear();
  maybeReached.clear();
  inFlight.clear();
  flushAgain.clear();
  lastChance.clear();
  answerListeners.clear();
}
