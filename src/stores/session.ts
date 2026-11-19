import { AppState, type NativeEventSubscription, Platform } from 'react-native';
import { create } from 'zustand';

import { ApiError } from '@/api/client';
import type { ServerAddresses, User } from '@/api/types';
import {
  knownAddresses,
  list as listKnownServers,
  remember as rememberServer,
  rememberAddresses,
} from '@/lib/known-servers';
import { connectionIdOf, priorConnection, serverIdOf } from '@/lib/connection-id';
import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';
import { forgetCalendarLink } from '@/lib/upcoming-calendar';
import { hostOf } from '@/lib/pairing';
import {
  type ProxyHeaders,
  proxyOriginOf,
  type ProxySets,
  proxySetFor,
  sameProxyHeaders,
} from '@/lib/proxy-headers';
import {
  forgetProxyHeaders,
  forgetProxySets,
  PROXY_SETS_KEY,
  readLegacyProxyHeaders,
  readProxySets,
  saveProxySets,
} from '@/lib/proxy-headers-store';
import { mergeAddresses, sameAddresses, sameUrl } from '@/lib/server-address';
import { onStoredChange, tabChannel, type TabChannel, type TabChannelEnv } from '@/lib/tab-channel';
import { tabLock } from '@/lib/tab-lock';
import { looksLikeHomeAddress } from '@/lib/url-host';
import { getItem, getItemStrict, removeItem, setItem } from '@/lib/storage';
import {
  CONNECTIONS_KEY,
  DEFAULT_CONNECTION_KEY as DEFAULT_KEY,
  DOWNLOADS_KEY,
  isRecord,
  LISTENING_OPEN_SPAN_KEY,
  LISTENING_OUTBOX_KEY,
  LISTENING_SYNC_KEY,
  OFFLINE_SERVERS_KEY,
  PROGRESS_MIRROR_KEY,
  PROGRESS_QUEUE_KEY,
  READING_MIRROR_KEY,
  READING_QUEUE_KEY,
  STARTUP_CACHE_KEY,
} from '@/lib/storage-keys';

// Multi-connection session: the app can be signed in to several servers at once.
// Connection metadata is kept in AsyncStorage (`CONNECTIONS_KEY`, the default's id under
// `DEFAULT_KEY`); each connection's token lives in secure-store under its own key.
/** Where a connection's session token lives in the secure store. */
const TOKEN_PREFIX = 'audiosilo.token.';
export const tokenKey = (id: string) => `${TOKEN_PREFIX}${id}`;

// Pre-multi-server single-session keys, cleared by the storage reset below.
const LEGACY_SERVER = 'audiosilo.serverUrl';
const LEGACY_TOKEN = 'audiosilo.token';
const LEGACY_USER = 'audiosilo.user';

// Storage schema is versioned along TWO independent axes so cache-schema churn can never
// log anyone out. Auth (connections + their secure-store session tokens) and the
// disposable per-server cache (downloads/progress) each carry their own version; a bump
// to one never touches the other. `resetStaleStorage()` reconciles both, awaited before
// any store hydrates (see `bootstrapPlayback`, `src/lib/bootstrap.ts`).
//
// AUTH version — gates ONLY the auth wipe (connections metadata + secure-store tokens +
// the default id + the legacy single-session keys). Session tokens never expire
// server-side, so wiping them is the ONE thing that logs a user out and forces a
// re-pair. v2 made connection ids the server-minted `server_id`, when the old,
// differently-keyed connections couldn't be re-keyed and had to be cleared. Doing so logs
// EVERY user out - a deliberate, rare, breaking act. NEVER bump it for a cache/scoped-state
// reason, and not for an identity change that CAN be re-keyed: Phase 8's
// `<server_id>.<user_id>` ids moved every connection with a one-time key migration
// (`src/lib/identity-migration.ts`) instead, and nobody was signed out.
const AUTH_STORAGE_VERSION_KEY = 'audiosilo.storageVersion';
const AUTH_STORAGE_VERSION = 2;
// CACHE version — gates ONLY the disposable per-server scoped cache (the SCOPED_STORAGE_KEYS
// below + the on-disk downloads root). Bump this for ANY scoped-state / cache schema
// change: it wipes downloads + the progress mirror/queue (they re-download / re-sync from
// the server) while keeping every connection's token intact, so NOBODY is logged out.
// This is the knob to reach for on cache churn.
const CACHE_VERSION_KEY = 'audiosilo.cacheVersion';
const CACHE_STORAGE_VERSION = 1;
// Per-server scoped storage owned by other stores, named from the leaf `storage-keys` so
// the reset is self-contained and can run before those stores hydrate (avoiding a store
// loading orphaned, wrongly-keyed data). Wiped on a cache bump, and also folded into an
// auth wipe (the connections that owned this cache are gone, so it's orphaned too).
const SCOPED_STORAGE_KEYS = [
  DOWNLOADS_KEY,
  PROGRESS_MIRROR_KEY,
  PROGRESS_QUEUE_KEY,
  READING_MIRROR_KEY,
  READING_QUEUE_KEY,
  LISTENING_OUTBOX_KEY,
  LISTENING_OPEN_SPAN_KEY,
  LISTENING_SYNC_KEY,
  OFFLINE_SERVERS_KEY,
  STARTUP_CACHE_KEY,
];

/** Outcome of `resetStaleStorage`: the two axes reset independently. */
export type StorageResetResult = {
  /** An auth wipe ran: connections + their tokens were cleared (everyone re-pairs). */
  authReset: boolean;
  /** A cache wipe ran: the scoped download/progress cache was cleared (logins intact). */
  cacheReset: boolean;
};

/**
 * One-time reconciliation of storage left incompatible by a version bump, split across two
 * independent axes so cache churn can never log anyone out. MUST be awaited before
 * session/downloads/progress hydrate (see `bootstrapPlayback`), so no store loads records
 * keyed on now-invalid connection ids. Returns which axes actually reset, so the caller can also
 * wipe the orphaned on-disk download files (outside AsyncStorage) when EITHER fired.
 *
 * AUTH axis: if the recorded `AUTH_STORAGE_VERSION` differs, wipe connections + their
 * secure-store tokens + the default + the legacy single-session keys (and, since those
 * connections owned it, the scoped cache too). For the current value `2` this is a no-op,
 * so a normal update logs NOBODY out.
 *
 * CACHE axis: if the recorded `CACHE_STORAGE_VERSION` differs, wipe only the scoped cache;
 * logins stay intact. A pre-existing healthy install (auth version already recorded, cache
 * version never written) ADOPTS the current cache version silently WITHOUT wiping - it
 * predates this split and its cache is valid, so we must not nuke its downloads on the
 * first launch of this code.
 *
 * The secure-store deletes are best-effort (`.catch`): a locked/unavailable keychain must
 * not reject the whole reset - that would leave a version unrecorded and, worse, abort the
 * caller's hydration (the app would hang on 'loading' forever). Losing a stale token is
 * harmless; the connection metadata it belonged to is being cleared anyway.
 */
export async function resetStaleStorage(): Promise<StorageResetResult> {
  const [authVersion, cacheVersion] = await Promise.all([
    getItem<number>(AUTH_STORAGE_VERSION_KEY),
    getItem<number>(CACHE_VERSION_KEY),
  ]);

  // --- AUTH axis --------------------------------------------------------------------
  let authReset = false;
  if (authVersion !== AUTH_STORAGE_VERSION) {
    // Best-effort delete of each old connection's token, then every auth key. The scoped
    // cache is folded in: its owning connections are being cleared, so it's now orphaned.
    const meta = (await getItem<PersistedConnection[]>(CONNECTIONS_KEY)) ?? [];
    // Each one's calendar link (Track U3) is a credential kept beside its token: it goes too.
    // So do the proxy headers (fe#167): every origin's, and an earlier build's per-connection
    // copies.
    await Promise.all([
      ...meta.flatMap((m) => [
        deleteSecure(tokenKey(m.id)).catch(() => undefined),
        forgetCalendarLink(m.id),
        forgetProxyHeaders(m.id),
      ]),
      forgetProxySets(),
    ]);
    await Promise.all([
      removeItem(CONNECTIONS_KEY),
      removeItem(DEFAULT_KEY),
      removeItem(LEGACY_SERVER),
      removeItem(LEGACY_USER),
      deleteSecure(LEGACY_TOKEN).catch(() => undefined),
      ...SCOPED_STORAGE_KEYS.map((k) => removeItem(k)),
    ]);
    await setItem(AUTH_STORAGE_VERSION_KEY, AUTH_STORAGE_VERSION);
    authReset = true;
  }

  // --- CACHE axis -------------------------------------------------------------------
  let cacheReset = false;
  if (cacheVersion !== CACHE_STORAGE_VERSION) {
    // A healthy pre-split install (auth version recorded, cache version never written)
    // ADOPTS the current version without wiping; if the auth axis already reset, the
    // scoped keys are already gone. Otherwise this is a real cache bump (or a brand-new
    // install, where the wipe is a harmless no-op): clear the scoped cache.
    const isPreexistingInstall = cacheVersion == null && authVersion != null;
    if (!isPreexistingInstall && !authReset) {
      await Promise.all(SCOPED_STORAGE_KEYS.map((k) => removeItem(k)));
      cacheReset = true;
    }
    await setItem(CACHE_VERSION_KEY, CACHE_STORAGE_VERSION);
  }

  return { authReset, cacheReset };
}

/**
 * Whether this install has been used before: it holds a persisted connection, a
 * remembered server (`known-servers`, which survives signing out), or a session from
 * before multi-server. Read straight from storage, so it works before any store
 * hydrates. The theme default (`migrateStorage`, which reads it before running
 * `resetStaleStorage`) uses it to tell an update (keep dark) from a fresh install (follow
 * the OS). The version keys are deliberately NOT a signal: `resetStaleStorage` writes them
 * on a fresh install's first launch.
 */
export async function hasExistingInstall(): Promise<boolean> {
  const [connections, known, legacyServer] = await Promise.all([
    getItem<unknown[]>(CONNECTIONS_KEY),
    listKnownServers(),
    getItem<string>(LEGACY_SERVER),
  ]);
  return (
    (Array.isArray(connections) && connections.length > 0) || known.length > 0 || !!legacyServer
  );
}

export type SessionStatus = 'loading' | 'unauthenticated' | 'authenticated';

// Owners of connection-scoped state (downloads, the progress mirror/queue, the
// query cache, scroll memory) register a cleanup here so `removeConnection` can
// purge it. Removing a connection orphans its scoped state (nothing else would ever drop
// it), so each owner must drop the removed id's records. This
// registry lives here - rather than session.ts importing those modules directly -
// because they import the session store, and a direct import would cycle.
const removalCleanups = new Set<(id: string) => void | Promise<void>>();

/** Register a purge run when a connection is removed. Returns an unsubscribe fn. */
export function onConnectionRemoved(fn: (id: string) => void | Promise<void>): () => void {
  removalCleanups.add(fn);
  return () => removalCleanups.delete(fn);
}

/** Run each of `fns` (the removal cleanups, the other-tab steps) for each of `ids`; one that
 * fails never blocks the others (nor the removal), it is only warned of (`what`). Each is
 * started in this call (a cleanup's first step is its mark that the connection is gone); one
 * that throws outright (not every one is async) fails as a rejection does. */
async function runEach(
  fns: ReadonlySet<(id: string) => void | Promise<void>>,
  ids: readonly string[],
  what: string,
): Promise<void> {
  const results = await Promise.allSettled(ids.flatMap((id) => [...fns].map(async (fn) => fn(id))));
  for (const r of results) {
    if (r.status === 'rejected') console.warn(`[session] ${what} failed`, r.reason);
  }
}

/** The connection list without `id`, and the default after it (the first left when it was
 * `id`): one rule for the removing tab and the tabs it tells. */
function withoutConnection(
  connections: readonly Connection[],
  defaultConnectionId: string | null,
  id: string,
): { next: Connection[]; nextDefault: string | null } {
  const next = connections.filter((c) => c.id !== id);
  return {
    next,
    nextDefault: defaultConnectionId === id ? (next[0]?.id ?? null) : defaultConnectionId,
  };
}

// Web: the tabs of the player share the stored connections, tokens and every connection's
// scoped state, but each holds its own copy in memory. Each tab follows what the others store
// (`followStored`: the list, the tokens and the proxy headers, read again whenever another
// tab writes one), and writes the list holding a lock the tabs share, reading it again first
// (`writingList`), so a tab never writes its older copy over another tab's sign-in. The
// default connection and the reconnect flags stay each tab's own (the default follows the
// stored one only once its own is gone). A tab that removes a connection, or retires one in a
// sign-in (`retired`: a word a tab of an earlier build ignores, where a `removed` would have
// it drop the person with it), also tells the others (`TABS_CHANNEL`), and each runs the
// removal's cleanups on its own copies (`removedInOtherTab`: its downloads, the queues and
// mirrors it holds, its query cache), which the removing tab cannot reach. Before it revokes
// a token, the removing tab gives a tab playing through it a bounded wait to send its place
// and its listening (`tellOtherTabsGoing`). Native is one runtime: no other tab.
type TabsMessage =
  | { removed: string }
  | { retired: string; replacedBy: string }
  | { going: string; ask: string }
  | { flushing: string; ask: string; tab: string }
  | { flushed: string; ask: string; tab: string };
const TABS_CHANNEL = 'audiosilo-connection-removed';
let tabsChannel: TabChannel<TabsMessage> | null | undefined;
let tabsEnv: TabChannelEnv | null | undefined;
let listening: (() => void) | null = null;
/** This tab, in the answers to a `going` word. */
const thisTab = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
/** The channel, opened on first use (null off the web). */
const tabsChannelOf = () =>
  tabsChannel === undefined ? (tabsChannel = tabChannel<TabsMessage>(TABS_CHANNEL)) : tabsChannel;

/** Where this tab hears the other tabs' writes (the browser's `storage` events): null off
 * the web. Resolved on first use, never at import. */
export function otherTabsEnv(): TabChannelEnv | null {
  if (tabsEnv === undefined) tabsEnv = Platform.OS === 'web' ? (globalThis as TabChannelEnv) : null;
  return tabsEnv;
}

/** Test-only: the channel and the storage events this tab hears the other tabs on (heard from
 * now on); null: none (as native). */
export function setTabsForTests(
  tabs: { channel: TabChannel<TabsMessage> | null; env: TabChannelEnv | null } | null,
): void {
  listening?.();
  listening = null;
  tabsChannel = tabs ? tabs.channel : undefined;
  tabsEnv = tabs ? tabs.env : undefined;
  if (tabs) listenToOtherTabs();
}

/** Hear the other tabs: their words on the channel, and their writes of the list and the
 * tokens. Once, from the launch's `hydrate`. Never at import: the web build's static render
 * imports this module in Node, where an open `BroadcastChannel` keeps the export's process
 * from exiting. */
function listenToOtherTabs(): void {
  if (listening) return;
  const unsubscribe = tabsChannelOf()?.subscribe(heard);
  const env = otherTabsEnv();
  const unfollow = env
    ? onStoredChange(
        (k) => k === CONNECTIONS_KEY || k.startsWith(TOKEN_PREFIX) || k === PROXY_SETS_KEY,
        storedMoved,
        env,
      )
    : undefined;
  listening = () => {
    unsubscribe?.();
    unfollow?.();
  };
}

function heard(m: unknown): void {
  if (!isRecord(m)) return;
  if (typeof m.removed === 'string') void removedInOtherTab(m.removed).catch(() => {});
  else if (typeof m.retired === 'string' && typeof m.replacedBy === 'string')
    void removedInOtherTab(m.retired, m.replacedBy).catch(() => {});
  else if (typeof m.going === 'string' && typeof m.ask === 'string')
    goingInOtherTab(m.going, m.ask);
}

/** Moved by every write of the stored sign-ins this tab knows of (another tab's, heard, and
 * its own, `persist`): a read of them that saw it move reads again. */
let storageMoves = 0;
/** The stored list (JSON) as this tab last read or wrote it. */
let knownList: string | null = null;
let following: Promise<void> | null = null;
let followedChange = false;
/** How many times a read of the stored sign-ins that another write moved is tried. */
const SETTLE_READS = 5;

/** Whether the session's change being told now is one this tab followed from another tab's
 * write. That tab writes what follows from it (the profiles document), and this tab takes it
 * from storage, never working it out from its own copy. */
export function sessionChangeFollowed(): boolean {
  return followedChange;
}

function setFollowed(state: Partial<SessionState>): void {
  followedChange = true;
  try {
    useSession.setState(state);
  } finally {
    followedChange = false;
  }
}

function storedMoved(): void {
  storageMoves++;
  void followStored();
}

type StoredSignIns = {
  /** The stored list's JSON (`knownList`). */
  list: string;
  /** Null when the stored list is empty or missing. */
  connections: Connection[] | null;
  defaultId: string | null;
  /** Every origin's proxy headers (fe#295, `readProxySets`). */
  proxySets: Record<string, ProxyHeaders>;
  /** The stored connections still marked as holding a set of their own, as earlier builds
   * kept them (`hasProxyHeaders`): `hydrate` moves those sets (`moveLegacyProxySets`), and a
   * tab that follows the list keeps their marks (`applyStored`). */
  marked: string[];
};

/** The stored connections with their tokens, and the proxy headers. A read that fails
 * rejects: a locked keychain fails the read of a set as it fails a token's, never a
 * connection that goes on without its headers. */
async function readStored(): Promise<StoredSignIns> {
  // Strict: a list that could not be read is a failed read, never "no connections"
  // (`getItem` would answer null).
  const [meta, defaultId, proxySets] = await Promise.all([
    getItemStrict<PersistedConnection[]>(CONNECTIONS_KEY),
    getItemStrict<string>(DEFAULT_KEY),
    // Read with no connection too: a set stays for its address after everyone signs out.
    readProxySets(),
  ]);
  const list = JSON.stringify(meta ?? null);
  const marked = (meta ?? []).filter((m) => m.hasProxyHeaders).map((m) => m.id);
  if (!meta || !meta.length) {
    return { list, connections: null, defaultId: defaultId ?? null, proxySets, marked };
  }
  const withTokens = await Promise.all(
    meta.map(async ({ hasProxyHeaders: _marked, ...m }) => {
      const token = await getSecure(tokenKey(m.id));
      if (!token) return null;
      return { ...m, serverId: serverIdOf(m), token } as Connection;
    }),
  );
  return {
    list,
    connections: withTokens.filter((c): c is Connection => c !== null),
    defaultId: defaultId ?? null,
    proxySets,
    marked,
  };
}

/**
 * The stored connections whose `hasProxyHeaders` mark is written again with the list
 * (`persist`): the ones whose own set (an earlier build's) is still where that build left it.
 * One this build could not read (a build that can still finds it), one whose move could not
 * be written at this launch (the next tries again), and one another tab marked since this
 * one launched (a tab of an earlier build keeping a set for its connection: moved at this
 * build's next launch, `applyStored`). A write of the list never drops a mark it does not
 * know of: the item behind it would stay in secure-store with nothing left to move it. A set
 * removed on purpose takes its old items and their marks with it (`forgetLegacyProxySets`).
 */
let legacyMarks: ReadonlySet<string> = new Set();

/** `m` as stored: marked again while its earlier build's set is not moved (`legacyMarks`). */
function withLegacyMark<T extends { id: string }>(m: T): T & { hasProxyHeaders?: true } {
  return legacyMarks.has(m.id) ? { ...m, hasProxyHeaders: true } : m;
}

/**
 * Move the sets earlier builds kept per connection (`marked`, `readLegacyProxyHeaders`) into
 * the one item kept per origin (fe#295): each becomes its origin's set unless that origin
 * has one already (the set stored per origin wins, then the first connection's in the list),
 * written and read back before any old item is deleted. A set this build can't read stays
 * where it is, marked (`legacyMarks`); a marker with no item behind it is dropped. The
 * markers are rewritten in the stored list here, so the next launch reads no old item again.
 *
 * A read the platform refuses rejects (the hydrate fails, as for a token: never a connection
 * that goes on without its headers). A move that can't be WRITTEN (storage full, a keystore
 * that refuses the write, a copy that does not read back) never fails the hydrate: the sets
 * are used from where they are for this launch, with every old item and its mark left for the
 * next one to move. A failed hydrate would show the listener as signed out at every launch,
 * and a sign-in then writes the list with that server alone (`setSession`).
 * Returns every origin's set after the move.
 */
async function moveLegacyProxySets(
  marked: readonly string[],
  stored: Record<string, ProxyHeaders>,
): Promise<Record<string, ProxyHeaders>> {
  if (!marked.length) {
    legacyMarks = new Set();
    return stored;
  }
  const read = await Promise.all(marked.map(readLegacyProxyHeaders));
  const adopt: Record<string, ProxyHeaders> = {};
  for (const set of read) {
    if (set && set !== 'unreadable' && !stored[set.origin] && !adopt[set.origin]) {
      adopt[set.origin] = set;
    }
  }
  let sets = stored;
  let moved = true;
  if (Object.keys(adopt).length) {
    try {
      await saveProxySets(adopt);
      const kept = await readProxySets();
      if (!Object.values(adopt).every((s) => sameProxyHeaders(kept[s.origin], s))) {
        throw new Error('the proxy headers move did not read back');
      }
      sets = kept;
    } catch (e) {
      console.warn('[session] moving the proxy headers failed, trying again next launch', e);
      moved = false;
      sets = { ...stored, ...adopt };
    }
  }
  // Not moved: every old item stays, marked. Moved: only the ones this build can't read.
  const keep = new Set(
    marked.filter((_, i) => (moved ? read[i] === 'unreadable' : read[i] !== null)),
  );
  legacyMarks = keep;
  await Promise.all(
    marked.filter((id, i) => read[i] !== null && !keep.has(id)).map(forgetProxyHeaders),
  );
  await writeLegacyMarks();
  return sets;
}

/** The markers as they now stand (`legacyMarks`) in the list as stored (the move runs before
 * the list is in memory): read again and written under the tabs' lock, so no other tab's
 * write is lost. */
function writeLegacyMarks(): Promise<void> {
  return writingList(async () => {
    const meta = await getItemStrict<PersistedConnection[]>(CONNECTIONS_KEY);
    if (!meta) return;
    const next = meta.map(({ hasProxyHeaders: _m, ...m }) => withLegacyMark(m));
    const text = JSON.stringify(next);
    if (text === JSON.stringify(meta)) return;
    knownList = text;
    storageMoves++;
    await setItem(CONNECTIONS_KEY, next);
  });
}

/**
 * Forget, with their marks, the sets an earlier build kept per connection for `origins` that
 * are still where it left them (`legacyMarks`: a move that could not be written, or another
 * tab's): a set removed on purpose must not be moved back in at the next launch. Best-effort
 * (the set is removed already): a read or write the platform refuses is only warned of. An
 * item this build can't read names no origin and stays.
 */
async function forgetLegacyProxySets(origins: readonly string[]): Promise<void> {
  if (!legacyMarks.size || !origins.length) return;
  try {
    const ids = [...legacyMarks];
    const read = await Promise.all(ids.map(readLegacyProxyHeaders));
    const drop = new Set(
      ids.filter((_, i) => {
        const set = read[i];
        return !!set && set !== 'unreadable' && origins.includes(set.origin);
      }),
    );
    if (!drop.size) return;
    await Promise.all([...drop].map(forgetProxyHeaders));
    const unmark = () => {
      legacyMarks = new Set([...legacyMarks].filter((id) => !drop.has(id)));
    };
    // A list that never loaded is not written (a mark with no item behind it is dropped at
    // the next launch). Else this tab's list as it is, never the stored copy read again (that
    // write could undo one of the list made meanwhile), unmarked once it is caught up with
    // the other tabs' (`applyStored` takes their marks in).
    if (useSession.getState().status === 'loading' || hydrateFailed) return unmark();
    await writingList(async () => {
      unmark();
      const { connections, defaultConnectionId } = useSession.getState();
      await persist(connections, defaultConnectionId);
    });
  } catch (e) {
    console.warn("[session] forgetting an earlier build's proxy headers failed", e);
  }
}

/** `readStored`, again while another write moved the stored sign-ins during the read
 * (`settled` false: still moving after `SETTLE_READS` reads). */
async function readSettled(): Promise<StoredSignIns & { settled: boolean }> {
  for (let attempt = 1; ; attempt++) {
    const moves = storageMoves;
    const read = await readStored();
    const settled = moves === storageMoves;
    if (settled || attempt >= SETTLE_READS) return { ...read, settled };
  }
}

/** One connection as far as a tab's copy of it goes: every field of `Connection` (a field
 * left out here is a change `applyStored` does not see). */
const connectionText = (c: Connection) =>
  JSON.stringify([
    c.id,
    serverIdOf(c),
    c.serverUrl,
    c.name,
    c.token,
    c.user,
    c.addresses ?? null,
    c.needsReconnect ?? null,
  ]);

/** Take what is stored (`read`) as this tab's list: its own default and reconnect flags kept
 * where they still apply. Nothing changes when the list is the one it holds. A connection
 * the list drops is left at once (`leaveConnection`, the player's stop), the word on the
 * channel or not, and only once the list has changed (the stop's saves must not go out with
 * the revoked token); the cleanups wait for the word (`removedInOtherTab`). Why: CONVENTIONS.md
 * (`followStored`). */
function applyStored(read: StoredSignIns): void {
  knownList = read.list;
  // A mark this tab did not write (`legacyMarks`): kept in this tab's writes of the list.
  if (read.marked.some((id) => !legacyMarks.has(id))) {
    legacyMarks = new Set([...legacyMarks, ...read.marked]);
  }
  const { connections: mine, defaultConnectionId, status, proxySets } = useSession.getState();
  // Another tab's edit of a set (fe#295): every connection's client on that origin follows.
  const sets = sameSets(proxySets, read.proxySets) ? null : { proxySets: read.proxySets };
  const next = (read.connections ?? []).map((c) => {
    const was = mine.find((m) => m.id === c.id);
    // A flag stays with the token it was raised for: a new one (signed in again in another
    // tab) clears it.
    return was?.needsReconnect && was.token === c.token
      ? { ...c, needsReconnect: was.needsReconnect }
      : c;
  });
  const same =
    next.length === mine.length &&
    next.every((c, i) => connectionText(c) === connectionText(mine[i]));
  const def = next.some((c) => c.id === defaultConnectionId) ? defaultConnectionId : read.defaultId;
  const mirrored = mirror(next, def);
  if (
    same &&
    !sets &&
    mirrored.defaultConnectionId === defaultConnectionId &&
    mirrored.status === status
  )
    return;
  setFollowed({ connections: same ? mine : next, ...mirrored, ...sets });
  for (const c of mine) if (!next.some((n) => n.id === c.id)) void leaveConnection(c.id);
}

/** Whether two origins-to-sets maps hold the same sets. */
function sameSets(a: ProxySets, b: ProxySets): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((o) => sameProxyHeaders(a[o], b[o]));
}

/** Read what the other tabs stored and take it (web, once the session is loaded: the hydrate
 * reads it before then). One read at a time; a write heard during it has it read again. */
function followStored(): Promise<void> {
  const loaded = () => useSession.getState().status !== 'loading' && !hydrateFailed;
  if (!otherTabsEnv() || !loaded()) return Promise.resolve();
  following ??= (async () => {
    let unsettled = false;
    try {
      const read = await readSettled();
      unsettled = !read.settled;
      if (loaded()) applyStored(read);
    } catch (e) {
      // Unreadable now: what this tab holds stays, and the next write heard reads again.
      console.warn("[session] reading another tab's sign-ins failed", e);
    } finally {
      following = null;
    }
    // Still moving when the reads ran out: the writes heard meanwhile were folded into this
    // follow, so it reads once more rather than leave the tab on an older list.
    if (unsettled) await followStored();
  })();
  return following;
}

/** Web: bring this tab's list up to the stored one, so a tab that has not heard another
 * tab's latest write yet never works from its older copy. Web only: callers ask
 * `otherTabsEnv()` first, so native keeps its timing. */
async function catchUp(): Promise<void> {
  if (following) await following;
  let stored: string;
  try {
    stored = JSON.stringify((await getItemStrict<PersistedConnection[]>(CONNECTIONS_KEY)) ?? null);
  } catch {
    return;
  }
  if (stored === knownList) return;
  storageMoves++;
  await followStored();
}

/** Web: catch this tab's list up with the stored one (`catchUp`), for a write that follows
 * from it made elsewhere (the profiles document's, `writeChanges`). Nothing off the web. */
export async function catchUpWithOtherTabs(): Promise<void> {
  if (otherTabsEnv()) await catchUp();
}

/** The lock every tab takes to write the stored list (`writingList`). */
const withListLock = tabLock(CONNECTIONS_KEY);

/** Run `job`, a read of this tab's list and a write of it (`persist`): on the web holding the
 * lock the tabs share for it, the list caught up with the stored one first (`catchUp`), so two
 * tabs writing at once never write over each other's change (each reads the other's write
 * before it makes its own). Off the web, `job` as it is. `job` must never wait on another
 * `writingList` (the lock is held while it runs). */
function writingList<T>(job: () => Promise<T>): Promise<T> {
  if (!otherTabsEnv()) return job();
  return withListLock(async () => {
    await catchUp();
    return job();
  });
}

// What a tab does first, before the cleanups, when a connection goes with no teardown run
// here before it (the player stops playing through it): another tab removed it (that tab
// ran its own, `teardownBeforeTokenRevoke`; this one runs it at the stored list or the word,
// whichever it hears first), or a sign-in here retired it as a stale identity (`setSession`).
const otherTabRemovalSteps = new Set<(id: string) => void | Promise<void>>();

/** Register a step run first when ANOTHER tab of the web player removed a connection (the
 * removing tab ran it itself before removing: `teardownBeforeTokenRevoke`), and when a
 * sign-in here retires a stale identity (nothing ran before that). Returns an
 * unsubscribe fn. */
export function onConnectionRemovedInOtherTab(
  fn: (id: string) => void | Promise<void>,
): () => void {
  otherTabRemovalSteps.add(fn);
  return () => otherTabRemovalSteps.delete(fn);
}

/** The other-tab removal steps running now, by connection. */
const leaving = new Map<string, Promise<void>>();

/** Run the other-tab removal steps for `id` (the player's stop), once at a time: a tab that
 * hears the stored list drop it (`applyStored`) and then the word (`removedInOtherTab`) waits
 * on the one stop, never starting a second beside it. A word heard once that one is done
 * asks again, and finds nothing playing through the connection. Also a sign-in's retirement
 * here (`setSession`, any platform). */
function leaveConnection(id: string): Promise<void> {
  let run = leaving.get(id);
  if (!run) {
    run = runEach(otherTabRemovalSteps, [id], 'connection leave step').finally(() =>
      leaving.delete(id),
    );
    leaving.set(id, run);
  }
  return run;
}

/**
 * Another tab removed the connection `id` (its token, calendar link and proxy headers
 * already deleted there, the stored list written), or retired it in a sign-in in favour of
 * `replacedBy` (the word `retired`): this tab moves the person to the replacing connection as
 * that tab did (`onConnectionReplaced`), takes the stored list (`followStored`; a removal
 * heard while this tab still hydrates has the hydrate read it again) and runs the removal's
 * cleanups. Nothing when its token is stored again (signed in again since, there or here), or
 * cannot be read; and no cleanups when it is stored again by the time this tab stopped
 * playing.
 */
async function removedInOtherTab(id: string, replacedBy?: string): Promise<void> {
  if (!id) return;
  storageMoves++;
  if ((await getSecure(tokenKey(id))) !== null) return;
  if (replacedBy) replaced(id, replacedBy);
  await followStored();
  // Not taken from storage (it could not be read): dropped from this tab's copy all the same.
  const { connections, defaultConnectionId } = useSession.getState();
  if (connections.some((c) => c.id === id)) {
    const { next, nextDefault } = withoutConnection(connections, defaultConnectionId, id);
    setFollowed({ connections: next, ...mirror(next, nextDefault) });
  }
  await leaveConnection(id);
  // Signed in again while this tab stopped (the stop waits its turn into the outbox): what
  // is stored of the connection now is the new sign-in's, in every tab, not this purge's.
  if ((await getSecure(tokenKey(id))) !== null) return;
  await runEach(removalCleanups, [id], 'connection-removed cleanup');
}

// What a tab does when another tab is about to revoke a connection's token: a tab playing
// through it stops and sends its place and listening while the token still works.
const goingSteps = new Set<(id: string) => Promise<void> | null>();

/** Register a step run when ANOTHER tab of the web player is about to revoke a connection's
 * token (`tellOtherTabsGoing`): its work, or null when this tab has none for it (its answer
 * is then nothing, so the removing tab does not wait on it). Returns an unsubscribe fn. */
export function onConnectionGoingInOtherTab(fn: (id: string) => Promise<void> | null): () => void {
  goingSteps.add(fn);
  return () => goingSteps.delete(fn);
}

function goingInOtherTab(id: string, ask: string): void {
  const work: Promise<void>[] = [];
  for (const fn of goingSteps) {
    try {
      const w = fn(id);
      if (w) work.push(w);
    } catch (e) {
      console.warn('[session] other-tab going step failed', e);
    }
  }
  const channel = tabsChannelOf();
  if (!work.length || !channel) return;
  channel.post({ flushing: id, ask, tab: thisTab });
  void Promise.allSettled(work).then(() => channel.post({ flushed: id, ask, tab: thisTab }));
}

/** How long a removing tab waits for the other tabs to say they have work for the connection
 * (`tellOtherTabsGoing`). Every removal on the web waits this long. */
const GOING_ANSWER_MS = 250;
/** The most a removing tab waits for the other tabs' work before it revokes the token. */
const GOING_FLUSH_MS = 3000;

/**
 * Web: tell the other tabs the connection `id` is about to go (its token revoked), and wait
 * until each that has work for it (a tab playing through it: its stop, place and listening
 * sent while the token works) says it is done, at most `flushMs`. A tab that says nothing
 * within `answerMs` has none. Run by the removing tab's teardown before its own flush
 * (`teardownBeforeTokenRevoke`). Nothing off the web.
 */
export async function tellOtherTabsGoing(
  id: string,
  { answerMs = GOING_ANSWER_MS, flushMs = GOING_FLUSH_MS } = {},
): Promise<void> {
  const channel = tabsChannelOf();
  if (!channel) return;
  const ask = `${thisTab}.${Math.random().toString(36).slice(2)}`;
  // The tabs that said they have work for it and have not said it is done.
  const pending = new Set<string>();
  await new Promise<void>((resolve) => {
    let answered = false;
    const finish = () => {
      clearTimeout(answerTimer);
      clearTimeout(flushTimer);
      unsubscribe();
      resolve();
    };
    const check = () => {
      if (answered && pending.size === 0) finish();
    };
    const unsubscribe = channel.subscribe((m: unknown) => {
      if (!isRecord(m) || m.ask !== ask || typeof m.tab !== 'string') return;
      if (m.flushing === id) pending.add(m.tab);
      else if (m.flushed === id) pending.delete(m.tab);
      check();
    });
    const answerTimer = setTimeout(() => {
      answered = true;
      check();
    }, answerMs);
    const flushTimer = setTimeout(finish, flushMs);
    channel.post({ going: id, ask });
  });
}

// Told when a sign-in retires a stale identity in favour of the new connection (a server
// that was reset, signed in to again by the same person): the profiles store moves the new
// id into the person that held the old one, so their PIN, name and kids settings stay.
// Called synchronously just before the session's list changes, so the reconcile that
// change triggers already finds the new id placed. A registry for the same cycle reason as
// `onConnectionRemoved`.
const replacementHooks = new Set<(oldId: string, newId: string) => void>();

/** Register a hook run when a sign-in replaces a stale identity (`retire`). Returns an
 * unsubscribe fn. */
export function onConnectionReplaced(fn: (oldId: string, newId: string) => void): () => void {
  replacementHooks.add(fn);
  return () => replacementHooks.delete(fn);
}

/** Run the replacement hooks for `oldId` -> `newId`; one that throws is only warned of. */
function replaced(oldId: string, newId: string): void {
  for (const fn of replacementHooks) {
    try {
      fn(oldId, newId);
    } catch (e) {
      console.warn('[session] connection-replaced hook failed', e);
    }
  }
}

/**
 * The stale identities a sign-in to `serverId` at `serverUrl` finds: connections to the
 * same address under ANOTHER `server_id` (a rebuilt server mints a new id at the same URL,
 * so their tokens are dead). Never because the user differs: a second person on the same
 * server is not stale. Which of them the sign-in may retire is the caller's (`retire`).
 *
 * At a home-network address (`looksLikeHomeAddress`: a private IP, a `.local` name) another
 * `server_id` is as likely another box at the same address on another network as this
 * server reset (fe#298), so there only the connections the sign-in names (`named`: a
 * reconnect's own) count; anyone else's stays as it was, unflagged and never retired.
 */
export function staleIdentities<C extends { id: string; serverId?: string; serverUrl: string }>(
  connections: readonly C[],
  serverId: string,
  serverUrl: string,
  named: readonly string[] = [],
): C[] {
  const home = looksLikeHomeAddress(serverUrl);
  return connections.filter(
    (c) =>
      serverIdOf(c) !== serverId &&
      sameUrl(c.serverUrl, serverUrl) &&
      (!home || named.includes(c.id)),
  );
}

/** Why a connection needs the user to re-pair before it works again. `auth` = the
 * session token was rejected (HTTP 401 - admin revoked it, or it's otherwise dead);
 * `server-reset` = the server was rebuilt from scratch and now reports a different
 * `server_id`, so this identity is gone. */
export type ReconnectReason = 'auth' | 'server-reset';

/** One user signed in to one server. `token` is held in memory; persisted to secure-store. */
export type Connection = {
  /** The connection id, `<server_id>.<user_id>` (`connectionIdOf`); a connection from
   * before Phase 8 that the key migration has not moved yet keeps its legacy id, the bare
   * `server_id`. It keys every per-connection store (`contentKey`, the token, the query
   * cache). Never compare it with a `server_id`: use `serverIdOf`. */
  id: string;
  /** The server's `server_id`. Set on every connection the session builds (`setSession`;
   * `hydrate` fills it for one persisted before Phase 8, whose legacy id IS the
   * `server_id`). Optional in the type only so a bare test fixture still type-checks:
   * read it through `serverIdOf(conn)`, which falls back to the id. */
  serverId?: string;
  serverUrl: string;
  name: string;
  token: string;
  user: User;
  /** Set when authenticated requests to this server are being rejected, so the UI can
   * surface a one-tap reconnect. IN-MEMORY ONLY (never persisted - excluded from
   * `PersistedConnection` and stripped in `persist`), so it's recomputed from the next
   * failure after a restart rather than sticking stale. The token is left intact; only a
   * successful re-pair (`setSession`) or a successful authed response
   * (`clearNeedsReconnect`) resolves it. */
  needsReconnect?: ReconnectReason;
  /** The server's home and away addresses (capability `addresses`), persisted with the
   * rest of the metadata (a connection saved before they existed simply has none: no
   * storage-version bump). The player picks which one to use by itself
   * (`src/api/address-route.ts`); `serverUrl` stays what the user paired with or typed. */
  addresses?: ServerAddresses;
};

/** Connection metadata persisted to AsyncStorage (the token and the in-memory reconnect flag
 * excluded - see secure-store / `needsReconnect`). `serverId` is absent on a connection saved
 * before Phase 8. `hasProxyHeaders`: an earlier build's mark of a set kept for this connection
 * alone (no secret), which `hydrate` moves to its origin's (`moveLegacyProxySets`); written
 * again only while that set is not moved (`legacyMarks`). */
export type PersistedConnection = Omit<Connection, 'token' | 'needsReconnect'> & {
  hasProxyHeaders?: true;
};

type SessionState = {
  status: SessionStatus;
  connections: Connection[];
  /** The default connection: where the connect flow lands and the fallback content
   * scope for chrome/aggregated screens (via `useCid()`). It no longer drives content -
   * each content screen carries its own connection in the route - so there's no
   * user-facing "switch active"; the default is simply the most recently paired
   * connection (or the first remaining one after a removal). */
  defaultConnectionId: string | null;
  /** The server URL being connected to during the connect → sign-in handoff. */
  pendingServerUrl: string | null;
  /** Proxy headers entered on the connect screen for the address being connected to
   * (fe#167): in memory only, sent by the connect flow's bare clients to that origin
   * (`connectProxyHeaders`), kept as that origin's set by `setSession`, then cleared. */
  pendingProxyHeaders: ProxyHeaders | null;
  /** Custom headers for an auth proxy in front of a server (fe#167): ONE set per https
   * origin, shared by every sign-in on this device that reaches a server there (fe#295),
   * whoever signs out, until it is removed or replaced on purpose (`setProxySet`, a sign-in
   * with a set typed for it). Credentials like the tokens: held in memory and in
   * secure-store (`src/lib/proxy-headers-store.ts`), never in the AsyncStorage metadata.
   * A client on an origin sends that origin's set (`proxySetFor`, `src/lib/proxy-headers.ts`). */
  proxySets: ProxySets;
  /** Mirror of the default connection's user, for ergonomic selectors. */
  user: User | null;

  /** Restore persisted connections on app start. */
  hydrate: () => Promise<void>;
  /** Add a connection for `user` on the server `serverId`, or update the one this device
   * already has for that user there (matched by `serverIdOf` + `user.id`, even at a
   * different URL), and make it the default (unless `opts.makeDefault` is false). Returns
   * the connection id: the existing one's (a legacy id stays until the key migration moves
   * it), else `connectionIdOf(serverId, user.id)`. */
  setSession: (
    s: {
      serverUrl: string;
      serverId: string;
      token: string;
      user: User;
      name?: string;
      /** The server's addresses from the pairing link, the redeem payload, or the exchange
       * / login answer (cleaned where they arrived). Absent keeps what the connection
       * already knew (a re-pair through an older server, or a link without them, must not
       * erase what a newer pairing taught it); present is merged with it
       * (`mergeAddresses`). */
      addresses?: ServerAddresses;
      /** The stale identities at this address (`staleIdentities`: a server that was reset)
       * this sign-in retires: the person signing in's own (`finishConnect` names them). Each
       * is dropped with its token and scoped state, and the new connection takes its place in
       * that person's profile (`onConnectionReplaced`). Every OTHER stale identity is kept,
       * flagged `server-reset`: it is another person's, theirs to sign in again, and dropping
       * it would delete them (their profile, PIN and kids settings) from the device. Absent:
       * none is retired. */
      retire?: readonly string[];
      /** The proxy headers the connect flow reached the server with (fe#167): kept as their
       * origin's set when they differ from it (a set typed for the address, which got in).
       * Absent (or null) changes nothing: a sign-in never removes a set. */
      proxyHeaders?: ProxyHeaders | null;
    },
    opts?: {
      /** False: the default connection stays where it is (a household member signed in on
       * the owner's device, `addMemberHere`: the owner keeps listening). It still becomes
       * the default when there is none yet, or the default is no longer signed in. Default
       * true. */
      makeDefault?: boolean;
    },
  ) => Promise<string>;
  /** Remember the server URL mid-connect, before authenticating. */
  setPendingServerUrl: (url: string) => Promise<void>;
  /** The proxy headers the connect screen holds for its address (null: none). */
  setPendingProxyHeaders: (set: ProxyHeaders | null) => void;
  /** Keep `set` as the proxy headers of the https origin `origin` (or, with null or an empty
   * set, remove that origin's): secure-store first, then memory, so every client on that
   * origin is rebuilt with them. `movedFrom`: an origin whose set this one replaces (the
   * Account card sending a set to another address), removed in the same write. A no-op for
   * an origin that is not an https one. */
  setProxySet: (origin: string, set: ProxyHeaders | null, movedFrom?: string) => Promise<void>;
  /** Update a specific connection's user (a `/me` refresh after a password change
   * lands on the connection it was made against, not whatever is default). */
  setConnectionUser: (id: string, user: User) => Promise<void>;
  /** What the server says a connection's addresses are now (`GET /addresses`, cleaned):
   * merged with what it kept (`mergeAddresses`: a home address survives an answer read
   * away from home), persisted, and mirrored to the remembered server (for a reconnect
   * after signing out). A no-op for an unknown connection or when nothing changes. */
  learnAddresses: (id: string, fresh: ServerAddresses | undefined) => Promise<void>;
  /** Update the default connection's user (sugar over `setConnectionUser`). */
  setUser: (user: User) => Promise<void>;
  /** Make a signed-in connection the default (a profile switch: the new person's first
   * server, `src/stores/profiles.ts`). A no-op for an unknown id or the default itself. */
  setDefaultConnection: (id: string) => Promise<void>;
  /** Remove one connection (deleting its token). Sign-out goes through this (via
   * `teardownBeforeTokenRevoke` first - see `use-sign-out.ts`), so there is no separate
   * `logout()`: it would revoke the token without the pre-revoke stop-playback + flush. */
  removeConnection: (id: string) => Promise<void>;
  /** Flag a connection as needing re-pairing (its token is being rejected, or the server
   * was reset). In-memory only; does NOT remove the connection or delete its token. A
   * no-op if the connection is unknown, already carries this exact reason, or would
   * downgrade a 'server-reset' flag to 'auth'. */
  markNeedsReconnect: (id: string, reason: ReconnectReason) => void;
  /** Clear a connection's reconnect flag (a successful authed response for it). A no-op
   * when it carries no flag, so it's cheap to call on every success. */
  clearNeedsReconnect: (id: string) => void;
};

/** Derive the default-connection mirror fields from the connection list. */
function mirror(connections: Connection[], defaultId: string | null) {
  const def = connections.find((c) => c.id === defaultId) ?? connections[0] ?? null;
  return {
    defaultConnectionId: def?.id ?? null,
    user: def?.user ?? null,
    status: (connections.length ? 'authenticated' : 'unauthenticated') as SessionStatus,
  };
}

/**
 * Whether the last hydrate failed, so the persisted connections are NOT in memory: a token
 * read threw. Until a hydrate succeeds nothing may act on the empty list as if it were the
 * real one: a sign-in would write it over the persisted one (keeping only its own server),
 * the offline queue's replay would drop every save as unroutable (`sessionReady`), and the
 * car would be told the listener signed out. The hydrate runs again when the app next comes
 * to the front, and while the phone is locked (`LOCKED_RETRY_MS`).
 */
let hydrateFailed = false;
let retryWhenActive: NativeEventSubscription | null = null;
let retryLocked: ReturnType<typeof setTimeout> | null = null;
let retrying: Promise<void> | null = null;

/** How often a session read the locked phone refused is tried again. The app may already
 * count as active (its CarPlay scene), so opening the phone need not change its state. */
export const LOCKED_RETRY_MS = 5_000;

export function sessionHydrateFailed(): boolean {
  return hydrateFailed;
}

/**
 * Whether a token read failed only because the phone is locked: iOS, a CarPlay launch with
 * the phone in a pocket, before the token moved to the item readable after first unlock
 * (the earlier one is readable only unlocked, `secure-store.ts`). It reads once the phone
 * is unlocked.
 */
export function isLockedKeychainError(e: unknown): boolean {
  if (Platform.OS !== 'ios') return false;
  const message = e instanceof Error ? e.message : String(e);
  return /interaction is not allowed/i.test(message);
}

/** One retry at a time, from either trigger. */
function retryHydrate() {
  retrying ??= useSession
    .getState()
    .hydrate()
    .finally(() => {
      retrying = null;
    });
}

/** Note how the hydrate ended: a failure hydrates again on the next foreground and, when
 * the phone was locked, every `LOCKED_RETRY_MS` until it reads. */
function hydrateEnded(failed: boolean, locked = false) {
  hydrateFailed = failed;
  retryWhenActive?.remove();
  retryWhenActive = null;
  if (retryLocked) clearTimeout(retryLocked);
  retryLocked = null;
  if (!failed) return;
  retryWhenActive = AppState.addEventListener('change', (next) => {
    if (next === 'active') retryHydrate();
  });
  if (locked) retryLocked = setTimeout(retryHydrate, LOCKED_RETRY_MS);
}

async function persist(connections: Connection[], defaultId: string | null) {
  // Strip the token (→ secure-store) AND the in-memory `needsReconnect` flag, so a stale
  // reconnect prompt never survives a restart (it's recomputed from the next failure). An
  // earlier build's set that is not moved keeps its mark (`legacyMarks`).
  const meta: PersistedConnection[] = connections.map(
    ({ token: _t, needsReconnect: _r, ...rest }) => withLegacyMark(rest),
  );
  // What this tab knows is stored now (`catchUp`), and a read of another tab's write that is
  // under way reads again, past this one.
  knownList = JSON.stringify(meta);
  storageMoves++;
  await Promise.all([setItem(CONNECTIONS_KEY, meta), setItem(DEFAULT_KEY, defaultId)]);
}

export const useSession = create<SessionState>()((set, get) => ({
  status: 'loading',
  connections: [],
  defaultConnectionId: null,
  pendingServerUrl: null,
  pendingProxyHeaders: null,
  proxySets: {},
  user: null,

  hydrate: async () => {
    // Web: the other tabs are heard from the launch on (`followStored`, `removedInOtherTab`).
    listenToOtherTabs();
    try {
      // A list that could not be read is a failed hydrate (retried, and nothing reconciles
      // against it), never "no connections". Read again when another tab wrote it meanwhile.
      const read = await readSettled();
      knownList = read.list;
      // An earlier build's per-connection sets go to their origins first (fe#295): a read
      // the platform refuses fails the hydrate, as a token read's does.
      const proxySets = await moveLegacyProxySets(read.marked, read.proxySets);
      hydrateEnded(false);
      if (read.connections) {
        set({
          connections: read.connections,
          proxySets,
          ...mirror(read.connections, read.defaultId),
        });
        return;
      }
      set({ status: 'unauthenticated', proxySets });
    } catch (e) {
      // The persisted connections are untouched, and loaded again later (`hydrateFailed`):
      // a JS runtime can outlive this launch (CarPlay's).
      const locked = isLockedKeychainError(e);
      if (!locked || !hydrateFailed) console.warn('[session] hydrate failed', e);
      hydrateEnded(true, locked);
      // A locked phone: still loading (the screens wait on their spinner, never on the
      // connect screen), since the read succeeds once it is unlocked. Anything else: fail
      // safe, never stuck on 'loading' (sessionReady() consumers would wait forever), so
      // unauthenticated, and the listener can sign in again.
      set({ status: locked ? 'loading' : 'unauthenticated' });
    }
  },

  setSession: async (
    { serverUrl, serverId, token, user, name, addresses, retire, proxyHeaders },
    { makeDefault = true } = {},
  ) => {
    // The connection id is the server-minted server_id plus the user's id
    // (`connectionIdOf`): it keys every per-connection store (downloads, the progress
    // mirror/queue, the query cache, scroll memory, the secure-store token). A blank
    // server_id would file distinct servers under one shared bucket and make the default
    // `useApi('')` throw, so refuse it loudly (the connect/sign-in flows surface this
    // ApiError) rather than silently corrupt scoped state.
    if (!serverId) throw new ApiError(0, 'Server did not return an id (server_id).');
    // The persisted connections first, when they never loaded: the list written below would
    // otherwise hold this server alone and drop every other one.
    if (hydrateFailed) await get().hydrate();
    // The proxy headers this sign-in got in with (fe#167), when they are not already their
    // origin's set (a set typed on the connect screen): kept for that origin, for everyone
    // on this device who reaches it (fe#295). First, so a set that can't be kept stores
    // nothing. A sign-in never removes a set.
    if (
      proxyHeaders?.headers.length &&
      !sameProxyHeaders(get().proxySets[proxyHeaders.origin], proxyHeaders)
    ) {
      await get().setProxySet(proxyHeaders.origin, proxyHeaders);
    }
    // On the web, the list as stored, with what another tab signed in or out since this tab
    // last heard, and no other tab's write between that read and this one (`writingList`).
    const { id, stale } = await writingList(async () => {
      const existing = get().connections;
      // Dedupe by the server's stable identity AND the user, so re-pairing the same account -
      // even at a different URL - updates its connection (and refreshes the URL) instead of
      // adding a duplicate. Another user on the same server is another connection. A legacy
      // connection (its id still the bare server_id) is matched the same way and KEEPS its id
      // until the key migration moves it, so its downloads and saves stay reachable; one saved
      // without a usable user id is taken to be this user only under the username it kept
      // (`priorConnection`, fe#298): one that kept none is never anyone's.
      const sameServer = existing.filter((c) => serverIdOf(c) === serverId);
      const prior = priorConnection(existing, serverId, user.id, user.username);
      const id = prior?.id ?? connectionIdOf(serverId, user.id);
      // A rebuilt server mints a NEW server_id at the SAME URL, so a connection to this URL
      // whose server_id differs is a stale identity of the same physical server (its token is
      // dead). The person signing in's own (`retire`) is dropped here, or re-pairing leaves a
      // zombie the reconnect banner keeps re-flagging on every /server hit. Anyone else's
      // stays, flagged 'server-reset' for them: never delete another person from the device.
      const candidates = staleIdentities(existing, serverId, serverUrl, retire).filter(
        (c) => c !== prior,
      );
      const stale = candidates.filter((c) => retire?.includes(c.id));
      const kept = new Set(candidates.filter((c) => !stale.includes(c)));
      // What the device knew of this server's addresses: the connection's, else another
      // user's connection to the same server, else (a sign-in again after signing out, from
      // the connect screen's remembered servers) the remembered server's, so a sign-in
      // through the away address doesn't forget the home one.
      const knew = prior
        ? prior.addresses
        : (sameServer.find((c) => c.addresses)?.addresses ?? (await knownAddresses(serverId)));
      const known = mergeAddresses(knew, addresses);
      const conn: Connection = {
        id,
        serverId,
        serverUrl,
        name: name ?? prior?.name ?? sameServer[0]?.name ?? hostOf(serverUrl),
        token,
        user,
        addresses: known,
      };
      const surviving = existing
        .filter((c) => !stale.includes(c))
        .map((c) => (kept.has(c) ? { ...c, needsReconnect: 'server-reset' as const } : c));
      const connections = prior
        ? surviving.map((c) => (c === prior ? conn : c))
        : [...surviving, conn];
      await setSecure(tokenKey(id), token);
      // Best-effort drop each stale identity's dead token. No server revoke - the token is
      // already dead, so there's nothing to call.
      // Their calendar links (Track U3) go with them, and any per-connection proxy headers
      // an earlier build left (fe#167; the origin's set stays for whoever reaches it).
      await Promise.all(
        stale.flatMap((c) => [
          deleteSecure(tokenKey(c.id)).catch(() => undefined),
          forgetCalendarLink(c.id),
          forgetProxyHeaders(c.id),
        ]),
      );
      // The default: this connection, unless the caller keeps the current one (which must
      // still be signed in; a retired stale identity can't stay the default).
      const current = get().defaultConnectionId;
      const defaultId =
        makeDefault || !current || !connections.some((c) => c.id === current) ? id : current;
      await persist(connections, defaultId);
      // The list just written is the one in memory: settled, even when the hydrate above failed
      // again (unreadable storage, not a locked phone: a sign-in means it is unlocked).
      if (hydrateFailed) hydrateEnded(false);
      // Remember this server durably (no token) so the connect screen can offer a one-tap
      // reconnect after a full logout. Upserts by serverId; best-effort (storage swallows).
      await rememberServer({ serverUrl, name: conn.name, serverId, addresses: known });
      // The person keeps their profile: the new connection takes the retired one's place.
      for (const c of stale) replaced(c.id, id);
      // Building `conn` fresh (with no `needsReconnect`) inherently clears any prior flag on
      // a re-pair of an existing connection.
      set({
        connections,
        pendingServerUrl: null,
        pendingProxyHeaders: null,
        ...mirror(connections, defaultId),
      });
      return { id, stale };
    });
    // Purge each dropped stale identity's scoped state (downloads, progress mirror/queue,
    // query cache, scroll memory), same semantics as removeConnection: run every cleanup,
    // never let one block the re-pair. No teardown ran before this (the connect flow has
    // none): a book still playing through the retired identity (its download) stops first,
    // as it does in a tab told of a removal, so its place and span are written before the
    // purge, not after it, and nothing plays on from files the purge deletes.
    if (stale.length) {
      const retired = stale.map((c) => c.id);
      // The web's other tabs move the person to this connection too, and purge what they
      // hold of each retired one (`removedInOtherTab`).
      for (const old of retired) tabsChannelOf()?.post({ retired: old, replacedBy: id });
      await Promise.all(retired.map(leaveConnection));
      await runEach(removalCleanups, retired, 'stale-identity cleanup');
    }
    return id;
  },

  setPendingServerUrl: async (url) => set({ pendingServerUrl: url }),

  setPendingProxyHeaders: (pendingProxyHeaders) => set({ pendingProxyHeaders }),

  setProxySet: async (origin, headers, movedFrom) => {
    const o = proxyOriginOf(origin);
    if (!o) return;
    const keep = headers?.headers.length && headers.origin === o ? headers : null;
    const from = movedFrom ? proxyOriginOf(movedFrom) : null;
    const gone = from && from !== o ? from : null;
    await saveProxySets({ ...(gone ? { [gone]: null } : {}), [o]: keep });
    // Set from the state as it is NOW (another origin's change may have landed meanwhile).
    const next = { ...get().proxySets };
    if (gone) delete next[gone];
    if (keep) next[o] = keep;
    else delete next[o];
    set({ proxySets: next });
    // A set still used from an earlier build's item (its move not written yet) is removed
    // there too, or the next launch would move it back.
    await forgetLegacyProxySets([...(gone ? [gone] : []), ...(keep ? [] : [o])]);
  },

  setConnectionUser: (id, user) =>
    writingList(async () => {
      const { connections, defaultConnectionId } = get();
      if (!connections.some((c) => c.id === id)) return;
      const next = connections.map((c) => (c.id === id ? { ...c, user } : c));
      await persist(next, defaultConnectionId);
      set({ connections: next, ...mirror(next, defaultConnectionId) });
    }),

  learnAddresses: (id, fresh) =>
    writingList(async () => {
      // Read and set in one synchronous step, persisting after: the address runner learns
      // every connection's addresses at once (launch, reconnect), and a list read before an
      // await would be set over another call's update (or bring back a connection removed
      // meanwhile).
      const { connections, defaultConnectionId } = get();
      const conn = connections.find((c) => c.id === id);
      if (!conn) return;
      const addresses = mergeAddresses(conn.addresses, fresh);
      if (sameAddresses(conn.addresses, addresses)) return;
      const next = connections.map((c) => (c.id === id ? { ...c, addresses } : c));
      set({ connections: next, ...mirror(next, defaultConnectionId) });
      // The remembered server is server-level (no user): keyed by the server's id, not this
      // connection's.
      await Promise.all([
        persist(next, defaultConnectionId),
        rememberAddresses(serverIdOf(conn), addresses),
      ]);
    }),

  setUser: async (user) => {
    const { defaultConnectionId } = get();
    if (defaultConnectionId) await get().setConnectionUser(defaultConnectionId, user);
  },

  setDefaultConnection: (id) =>
    writingList(async () => {
      const { connections, defaultConnectionId } = get();
      if (id === defaultConnectionId || !connections.some((c) => c.id === id)) return;
      set(mirror(connections, id));
      await persist(connections, id);
    }),

  removeConnection: async (id) => {
    // The connection's calendar link (Track U3) is a credential like its token: this device
    // forgets it with the connection (the link itself keeps working until turned off), and
    // any proxy headers an earlier build kept for it alone. The origin's set stays (fe#295):
    // removed only on purpose, so signing in again there needs no typing. The token first:
    // a delete of it that fails stops the removal.
    await deleteSecure(tokenKey(id));
    await Promise.all([forgetCalendarLink(id), forgetProxyHeaders(id)]);
    await writingList(async () => {
      const { connections, defaultConnectionId } = get();
      const { next, nextDefault } = withoutConnection(connections, defaultConnectionId, id);
      await persist(next, nextDefault);
      set({ connections: next, ...mirror(next, nextDefault) });
    });
    // The web's other tabs forget it too, and purge what they hold of it
    // (`removedInOtherTab`): told once the list is written and the token gone.
    tabsChannelOf()?.post({ removed: id });
    // Purge the removed connection's scoped state (downloads, progress mirror/queue,
    // query cache, scroll memory). A failing cleanup must never block removal, so run
    // them all and only warn on rejection.
    await runEach(removalCleanups, [id], 'connection-removed cleanup');
  },

  markNeedsReconnect: (id, reason) => {
    const { connections } = get();
    const conn = connections.find((c) => c.id === id);
    // No-op if unknown, or already flagged with this exact reason - so repeated 401s
    // across many in-flight queries don't churn state (and re-render everything).
    if (!conn || conn.needsReconnect === reason) return;
    // Never downgrade 'server-reset' to 'auth': it's the rarer, strictly-more-informative
    // reason (a fresh server_id), and frequent authed 401s ('auth') would otherwise clobber
    // it. It stays until cleared or a re-pair; the 'auth' → 'server-reset' upgrade is allowed.
    if (conn.needsReconnect === 'server-reset' && reason === 'auth') return;
    // In-memory only: don't persist (the flag is recomputed from the next failure).
    set({
      connections: connections.map((c) => (c.id === id ? { ...c, needsReconnect: reason } : c)),
    });
  },

  clearNeedsReconnect: (id) => {
    const { connections } = get();
    const conn = connections.find((c) => c.id === id);
    // No-op when there's no flag, so calling this on every successful query is cheap.
    if (!conn?.needsReconnect) return;
    set({
      connections: connections.map((c) => (c.id === id ? { ...c, needsReconnect: undefined } : c)),
    });
  },
}));

/** A signed-in server's name ('' for none): "isn't on <server>", a card's server line. */
export function useConnectionName(connectionId: string | undefined): string {
  return useSession((s) => s.connections.find((c) => c.id === connectionId)?.name ?? '');
}

/**
 * The proxy headers a request to `url` made outside a signed-in connection's client should
 * carry (the connect flow's bare clients, the home-address probe): the ones the connect
 * screen holds for that origin, else the set kept for it (`proxySetFor`: whoever's sign-in
 * kept it, since there is one per origin, fe#295). Null when there are none for it. The
 * client still sends them only to their own origin (`proxyHeaderRecord`).
 */
export function connectProxyHeaders(url: string): ProxyHeaders | null {
  const origin = proxyOriginOf(url);
  if (!origin) return null;
  const { pendingProxyHeaders, proxySets } = useSession.getState();
  if (pendingProxyHeaders?.origin === origin) return pendingProxyHeaders;
  return proxySetFor(proxySets, url);
}
