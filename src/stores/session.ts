import { create } from 'zustand';

import type { User } from '@/api/types';
import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';
import { getItem, removeItem, setItem } from '@/lib/storage';

// Multi-connection session: the app can be signed in to several servers at once.
// Connection metadata is kept in AsyncStorage; each connection's token lives in
// secure-store under its own key.
const CONNECTIONS_KEY = 'audiosilo.connections';
const ACTIVE_KEY = 'audiosilo.activeConnection';
const tokenKey = (id: string) => `audiosilo.token.${id}`;

// Pre-multi-server single-session keys, cleared by the storage reset below.
const LEGACY_SERVER = 'audiosilo.serverUrl';
const LEGACY_TOKEN = 'audiosilo.token';
const LEGACY_USER = 'audiosilo.user';

// Bumped when a change makes previously-persisted client state incompatible. v2:
// connection ids became the server-minted `server_id` (were random and device-local),
// so old connections and their per-server state can't be re-keyed and are cleared once
// (the user re-pairs). `resetStaleStorage()` runs, awaited, before any store hydrates.
const VERSION_KEY = 'audiosilo.storageVersion';
const STORAGE_VERSION = 2;
// Per-server scoped storage owned by other stores, cleared alongside connections on an
// incompatible upgrade. Duplicated here so the reset is self-contained and can run
// before those stores hydrate (avoiding a store loading orphaned, wrongly-keyed data).
const SCOPED_STORAGE_KEYS = [
  'audiosilo.downloads',
  'audiosilo.progressMirror',
  'audiosilo.progressQueue',
];

/**
 * One-time reset of client state left incompatible by a `STORAGE_VERSION` bump. MUST be
 * awaited before session/downloads/progress hydrate (see `_layout.tsx`), so no store
 * loads records keyed on the old, now-invalid connection ids. A no-op once the current
 * version has been recorded (every launch after the first post-upgrade one).
 */
export async function resetStaleStorage(): Promise<void> {
  const version = await getItem<number>(VERSION_KEY);
  if (version === STORAGE_VERSION) return;
  // Best-effort delete of each old connection's token, then every incompatible key.
  const meta = (await getItem<PersistedConnection[]>(CONNECTIONS_KEY)) ?? [];
  await Promise.all(meta.map((m) => deleteSecure(tokenKey(m.id))));
  await Promise.all([
    removeItem(CONNECTIONS_KEY),
    removeItem(ACTIVE_KEY),
    removeItem(LEGACY_SERVER),
    removeItem(LEGACY_USER),
    deleteSecure(LEGACY_TOKEN),
    ...SCOPED_STORAGE_KEYS.map((k) => removeItem(k)),
  ]);
  await setItem(VERSION_KEY, STORAGE_VERSION);
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

/** One signed-in server. `token` is held in memory; persisted to secure-store. */
export type Connection = {
  id: string;
  serverUrl: string;
  name: string;
  token: string;
  user: User;
};

/** Connection metadata persisted to AsyncStorage (token excluded - see secure-store). */
type PersistedConnection = Omit<Connection, 'token'>;

type SessionState = {
  status: SessionStatus;
  connections: Connection[];
  activeConnectionId: string | null;
  /** The server URL being connected to during the connect → sign-in handoff. */
  pendingServerUrl: string | null;
  /** Mirrors of the active connection, for ergonomic selectors. */
  user: User | null;
  activeServerUrl: string | null;

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
  /** Update a specific connection's user (a `/me` refresh after a password/recovery
   * change lands on the connection it was made against, not whatever is active). */
  setConnectionUser: (id: string, user: User) => Promise<void>;
  /** Update the active connection's user (sugar over `setConnectionUser`). */
  setUser: (user: User) => Promise<void>;
  setActiveConnection: (id: string) => Promise<void>;
  /** Remove one connection (deleting its token). */
  removeConnection: (id: string) => Promise<void>;
  /** Sign out of the active connection (remove it). */
  logout: () => Promise<void>;
};

function hostName(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || url;
}

/** Derive the active-connection mirror fields from the connection list. */
function mirror(connections: Connection[], activeId: string | null) {
  const active = connections.find((c) => c.id === activeId) ?? connections[0] ?? null;
  return {
    activeConnectionId: active?.id ?? null,
    user: active?.user ?? null,
    activeServerUrl: active?.serverUrl ?? null,
    status: (connections.length ? 'authenticated' : 'unauthenticated') as SessionStatus,
  };
}

async function persist(connections: Connection[], activeId: string | null) {
  const meta: PersistedConnection[] = connections.map(({ token: _t, ...rest }) => rest);
  await Promise.all([setItem(CONNECTIONS_KEY, meta), setItem(ACTIVE_KEY, activeId)]);
}

export const useSession = create<SessionState>()((set, get) => ({
  status: 'loading',
  connections: [],
  activeConnectionId: null,
  pendingServerUrl: null,
  user: null,
  activeServerUrl: null,

  hydrate: async () => {
    try {
      const [meta, activeId] = await Promise.all([
        getItem<PersistedConnection[]>(CONNECTIONS_KEY),
        getItem<string>(ACTIVE_KEY),
      ]);

      if (meta && meta.length) {
        const withTokens = await Promise.all(
          meta.map(async (m) => {
            const token = await getSecure(tokenKey(m.id));
            return token ? ({ ...m, token } as Connection) : null;
          }),
        );
        const connections = withTokens.filter((c): c is Connection => c !== null);
        set({ connections, ...mirror(connections, activeId ?? null) });
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
    set({ connections, pendingServerUrl: null, ...mirror(connections, serverId) });
    return serverId;
  },

  setPendingServerUrl: async (url) => set({ pendingServerUrl: url }),

  setConnectionUser: async (id, user) => {
    const { connections, activeConnectionId } = get();
    if (!connections.some((c) => c.id === id)) return;
    const next = connections.map((c) => (c.id === id ? { ...c, user } : c));
    await persist(next, activeConnectionId);
    set({ connections: next, ...mirror(next, activeConnectionId) });
  },

  setUser: async (user) => {
    const { activeConnectionId } = get();
    if (activeConnectionId) await get().setConnectionUser(activeConnectionId, user);
  },

  setActiveConnection: async (id) => {
    const { connections } = get();
    if (!connections.some((c) => c.id === id)) return;
    await setItem(ACTIVE_KEY, id);
    set(mirror(connections, id));
  },

  removeConnection: async (id) => {
    const { connections, activeConnectionId } = get();
    const next = connections.filter((c) => c.id !== id);
    const nextActive = activeConnectionId === id ? (next[0]?.id ?? null) : activeConnectionId;
    await deleteSecure(tokenKey(id));
    await persist(next, nextActive);
    set({ connections: next, ...mirror(next, nextActive) });
    // Purge the removed connection's scoped state (downloads, progress mirror/queue,
    // query cache, scroll memory). A failing cleanup must never block removal, so run
    // them all and only warn on rejection.
    const results = await Promise.allSettled([...removalCleanups].map((fn) => fn(id)));
    for (const r of results) {
      if (r.status === 'rejected')
        console.warn('[session] connection-removed cleanup failed', r.reason);
    }
  },

  logout: async () => {
    const { activeConnectionId } = get();
    if (activeConnectionId) await get().removeConnection(activeConnectionId);
  },
}));
