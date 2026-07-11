import { create } from 'zustand';

import { ApiError } from '@/api/client';
import type { User } from '@/api/types';
import { remember as rememberServer } from '@/lib/known-servers';
import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';
import { getItem, removeItem, setItem } from '@/lib/storage';

// Multi-connection session: the app can be signed in to several servers at once.
// Connection metadata is kept in AsyncStorage; each connection's token lives in
// secure-store under its own key.
const CONNECTIONS_KEY = 'audiosilo.connections';
// The default connection's id. The string is the legacy `activeConnection` name, kept
// stable so an existing install's persisted default survives the active→default rename.
const DEFAULT_KEY = 'audiosilo.activeConnection';
const tokenKey = (id: string) => `audiosilo.token.${id}`;

// Pre-multi-server single-session keys, cleared by the storage reset below.
const LEGACY_SERVER = 'audiosilo.serverUrl';
const LEGACY_TOKEN = 'audiosilo.token';
const LEGACY_USER = 'audiosilo.user';

// Storage schema is versioned along TWO independent axes so cache-schema churn can never
// log anyone out. Auth (connections + their secure-store session tokens) and the
// disposable per-server cache (downloads/progress) each carry their own version; a bump
// to one never touches the other. `resetStaleStorage()` reconciles both, awaited before
// any store hydrates (see `_layout.tsx`).
//
// AUTH version — gates ONLY the auth wipe (connections metadata + secure-store tokens +
// the default id + the legacy single-session keys). Session tokens never expire
// server-side, so wiping them is the ONE thing that logs a user out and forces a
// re-pair. Bump this ONLY when the connection IDENTITY SCHEME itself changes (like v2:
// connection ids became the server-minted `server_id`, so old, differently-keyed
// connections can't be re-keyed and must be cleared). Doing so logs EVERY user out - a
// deliberate, rare, breaking act. NEVER bump it for a cache/scoped-state reason.
const AUTH_STORAGE_VERSION_KEY = 'audiosilo.storageVersion';
const AUTH_STORAGE_VERSION = 2;
// CACHE version — gates ONLY the disposable per-server scoped cache (the SCOPED_STORAGE_KEYS
// below + the on-disk downloads root). Bump this for ANY scoped-state / cache schema
// change: it wipes downloads + the progress mirror/queue (they re-download / re-sync from
// the server) while keeping every connection's token intact, so NOBODY is logged out.
// This is the knob to reach for on cache churn.
const CACHE_VERSION_KEY = 'audiosilo.cacheVersion';
const CACHE_STORAGE_VERSION = 1;
// Per-server scoped storage owned by other stores. Duplicated here so the reset is
// self-contained and can run before those stores hydrate (avoiding a store loading
// orphaned, wrongly-keyed data). Wiped on a cache bump, and also folded into an auth
// wipe (the connections that owned this cache are gone, so it's orphaned too).
const SCOPED_STORAGE_KEYS = [
  'audiosilo.downloads',
  'audiosilo.progressMirror',
  'audiosilo.progressQueue',
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
 * session/downloads/progress hydrate (see `_layout.tsx`), so no store loads records keyed
 * on now-invalid connection ids. Returns which axes actually reset, so the caller can also
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
    await Promise.all(meta.map((m) => deleteSecure(tokenKey(m.id)).catch(() => undefined)));
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
    const isPreexistingInstall = cacheVersion == null && authVersion != null;
    if (isPreexistingInstall) {
      // A healthy install that predates the cache-version split (its auth version was
      // already recorded). Its cache is valid - ADOPT the current cache version silently,
      // never wiping the user's downloads on the first launch of this code.
    } else if (!authReset) {
      // A real cache-schema bump (recorded but differs), or a brand-new install (nothing
      // stored, so the wipe is a harmless no-op). Either way, clear the scoped cache.
      await Promise.all(SCOPED_STORAGE_KEYS.map((k) => removeItem(k)));
      cacheReset = true;
    }
    // else: the auth axis already wiped the scoped keys and the caller clears the
    // downloads root via `authReset`, so there's no extra cache work - just stamp below.
    await setItem(CACHE_VERSION_KEY, CACHE_STORAGE_VERSION);
  }

  return { authReset, cacheReset };
}

export type SessionStatus = 'loading' | 'unauthenticated' | 'authenticated';

// Owners of connection-scoped state (downloads, the progress mirror/queue, the
// query cache, scroll memory) register a cleanup here so `removeConnection` can
// purge it. Removing a connection orphans its scoped state forever (re-adding a
// server mints a new id), so each owner must drop the removed id's records. This
// registry lives here - rather than session.ts importing those modules directly -
// because they import the session store, and a direct import would cycle.
const removalCleanups = new Set<(id: string) => void | Promise<void>>();

/** Register a purge run when a connection is removed. Returns an unsubscribe fn. */
export function onConnectionRemoved(fn: (id: string) => void | Promise<void>): () => void {
  removalCleanups.add(fn);
  return () => removalCleanups.delete(fn);
}

/** Why a connection needs the user to re-pair before it works again. `auth` = the
 * session token was rejected (HTTP 401 - admin revoked it, or it's otherwise dead);
 * `server-reset` = the server was rebuilt from scratch and now reports a different
 * `server_id`, so this identity is gone. */
export type ReconnectReason = 'auth' | 'server-reset';

/** One signed-in server. `token` is held in memory; persisted to secure-store. */
export type Connection = {
  id: string;
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
};

/** Connection metadata persisted to AsyncStorage (token + the in-memory reconnect flag
 * excluded - see secure-store / `needsReconnect`). */
type PersistedConnection = Omit<Connection, 'token' | 'needsReconnect'>;

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
  /** Mirror of the default connection's user, for ergonomic selectors. */
  user: User | null;

  /** Restore persisted connections on app start. */
  hydrate: () => Promise<void>;
  /** Add (or update, matched by the server's stable `serverId`) a connection and make
   * it the default. Returns the connection id (= serverId). */
  setSession: (s: {
    serverUrl: string;
    serverId: string;
    token: string;
    user: User;
    name?: string;
  }) => Promise<string>;
  /** Remember the server URL mid-connect, before authenticating. */
  setPendingServerUrl: (url: string) => Promise<void>;
  /** Update a specific connection's user (a `/me` refresh after a password change
   * lands on the connection it was made against, not whatever is default). */
  setConnectionUser: (id: string, user: User) => Promise<void>;
  /** Update the default connection's user (sugar over `setConnectionUser`). */
  setUser: (user: User) => Promise<void>;
  /** Remove one connection (deleting its token). Sign-out goes through this (via
   * `teardownBeforeTokenRevoke` first - see `use-sign-out.ts`), so there is no separate
   * `logout()`: it would revoke the token without the pre-revoke stop-playback + flush. */
  removeConnection: (id: string) => Promise<void>;
  /** Flag a connection as needing re-pairing (its token is being rejected, or the server
   * was reset). In-memory only; does NOT remove the connection or delete its token. A
   * no-op if the connection is unknown or already carries this exact reason. */
  markNeedsReconnect: (id: string, reason: ReconnectReason) => void;
  /** Clear a connection's reconnect flag (a successful authed response for it). A no-op
   * when it carries no flag, so it's cheap to call on every success. */
  clearNeedsReconnect: (id: string) => void;
};

function hostName(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || url;
}

/** Derive the default-connection mirror fields from the connection list. */
function mirror(connections: Connection[], defaultId: string | null) {
  const def = connections.find((c) => c.id === defaultId) ?? connections[0] ?? null;
  return {
    defaultConnectionId: def?.id ?? null,
    user: def?.user ?? null,
    status: (connections.length ? 'authenticated' : 'unauthenticated') as SessionStatus,
  };
}

async function persist(connections: Connection[], defaultId: string | null) {
  // Strip the token (→ secure-store) AND the in-memory `needsReconnect` flag, so a stale
  // reconnect prompt never survives a restart (it's recomputed from the next failure).
  const meta: PersistedConnection[] = connections.map(
    ({ token: _t, needsReconnect: _r, ...rest }) => rest,
  );
  await Promise.all([setItem(CONNECTIONS_KEY, meta), setItem(DEFAULT_KEY, defaultId)]);
}

export const useSession = create<SessionState>()((set, get) => ({
  status: 'loading',
  connections: [],
  defaultConnectionId: null,
  pendingServerUrl: null,
  user: null,

  hydrate: async () => {
    try {
      const [meta, defaultId] = await Promise.all([
        getItem<PersistedConnection[]>(CONNECTIONS_KEY),
        getItem<string>(DEFAULT_KEY),
      ]);

      if (meta && meta.length) {
        const withTokens = await Promise.all(
          meta.map(async (m) => {
            const token = await getSecure(tokenKey(m.id));
            return token ? ({ ...m, token } as Connection) : null;
          }),
        );
        const connections = withTokens.filter((c): c is Connection => c !== null);
        set({ connections, ...mirror(connections, defaultId ?? null) });
        return;
      }

      set({ status: 'unauthenticated' });
    } catch (e) {
      // Fail safe: never leave status stuck on 'loading' (that would hang sessionReady()
      // consumers and the offline-replay flush forever). Surface as unauthenticated; the
      // persisted connections are untouched, so a future clean launch restores them.
      console.warn('[session] hydrate failed', e);
      set({ status: 'unauthenticated' });
    }
  },

  setSession: async ({ serverUrl, serverId, token, user, name }) => {
    // The connection id IS the server-minted server_id: it keys every per-server store
    // (downloads, the progress mirror/queue, the query cache, scroll memory, the
    // secure-store token). A blank id would file distinct servers under one shared bucket
    // and make the default `useApi('')` throw, so refuse it loudly (the connect/sign-in
    // flows surface this ApiError) rather than silently corrupt scoped state.
    if (!serverId) throw new ApiError(0, 'Server did not return an id (server_id).');
    const existing = get().connections;
    // Dedupe by the server's stable identity, so re-pairing the same server - even at a
    // different URL - updates its connection (and refreshes the URL) instead of adding a
    // duplicate.
    const prior = existing.find((c) => c.id === serverId);
    const conn: Connection = {
      id: serverId,
      serverUrl,
      name: name ?? prior?.name ?? hostName(serverUrl),
      token,
      user,
    };
    const connections = prior
      ? existing.map((c) => (c.id === serverId ? conn : c))
      : [...existing, conn];
    await setSecure(tokenKey(serverId), token);
    await persist(connections, serverId);
    // Remember this server durably (no token) so the connect screen can offer a one-tap
    // reconnect after a full logout. Upserts by serverId; best-effort (storage swallows).
    await rememberServer({ serverUrl, name: conn.name, serverId });
    // Building `conn` fresh (with no `needsReconnect`) inherently clears any prior flag on
    // a re-pair of an existing connection.
    set({ connections, pendingServerUrl: null, ...mirror(connections, serverId) });
    return serverId;
  },

  setPendingServerUrl: async (url) => set({ pendingServerUrl: url }),

  setConnectionUser: async (id, user) => {
    const { connections, defaultConnectionId } = get();
    if (!connections.some((c) => c.id === id)) return;
    const next = connections.map((c) => (c.id === id ? { ...c, user } : c));
    await persist(next, defaultConnectionId);
    set({ connections: next, ...mirror(next, defaultConnectionId) });
  },

  setUser: async (user) => {
    const { defaultConnectionId } = get();
    if (defaultConnectionId) await get().setConnectionUser(defaultConnectionId, user);
  },

  removeConnection: async (id) => {
    const { connections, defaultConnectionId } = get();
    const next = connections.filter((c) => c.id !== id);
    const nextDefault = defaultConnectionId === id ? (next[0]?.id ?? null) : defaultConnectionId;
    await deleteSecure(tokenKey(id));
    await persist(next, nextDefault);
    set({ connections: next, ...mirror(next, nextDefault) });
    // Purge the removed connection's scoped state (downloads, progress mirror/queue,
    // query cache, scroll memory). A failing cleanup must never block removal, so run
    // them all and only warn on rejection.
    const results = await Promise.allSettled([...removalCleanups].map((fn) => fn(id)));
    for (const r of results) {
      if (r.status === 'rejected')
        console.warn('[session] connection-removed cleanup failed', r.reason);
    }
  },

  markNeedsReconnect: (id, reason) => {
    const { connections } = get();
    const conn = connections.find((c) => c.id === id);
    // No-op if unknown, or already flagged with this exact reason - so repeated 401s
    // across many in-flight queries don't churn state (and re-render everything).
    if (!conn || conn.needsReconnect === reason) return;
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
