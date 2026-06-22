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

// Legacy single-session keys, migrated into one connection on first hydrate.
const LEGACY_SERVER = 'audiosilo.serverUrl';
const LEGACY_TOKEN = 'audiosilo.token';
const LEGACY_USER = 'audiosilo.user';

export type SessionStatus = 'loading' | 'unauthenticated' | 'authenticated';

/** One signed-in server. `token` is held in memory; persisted to secure-store. */
export type Connection = {
  id: string;
  serverUrl: string;
  name: string;
  token: string;
  user: User;
};

/** Connection metadata persisted to AsyncStorage (token excluded — see secure-store). */
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

  /** Restore persisted connections on app start (migrating any legacy session). */
  hydrate: () => Promise<void>;
  /** Add (or update, matched by server URL) a connection and make it active. */
  setSession: (s: {
    serverUrl: string;
    token: string;
    user: User;
    name?: string;
  }) => Promise<string>;
  /** Remember the server URL mid-connect, before authenticating. */
  setPendingServerUrl: (url: string) => Promise<void>;
  /** Update the active connection's user. */
  setUser: (user: User) => Promise<void>;
  setActiveConnection: (id: string) => Promise<void>;
  reorderConnections: (ids: string[]) => Promise<void>;
  /** Remove one connection (deleting its token). */
  removeConnection: (id: string) => Promise<void>;
  /** Sign out of the active connection (remove it). */
  logout: () => Promise<void>;
};

function hostName(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || url;
}

function newId(existing: Connection[]): string {
  let id = '';
  do {
    id = Math.random().toString(36).slice(2, 10);
  } while (existing.some((c) => c.id === id));
  return id;
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

    // Migrate a pre-multi-connection single session, if present.
    const [legacyServer, legacyToken, legacyUser] = await Promise.all([
      getItem<string>(LEGACY_SERVER),
      getSecure(LEGACY_TOKEN),
      getItem<User>(LEGACY_USER),
    ]);
    if (legacyServer && legacyToken && legacyUser) {
      const conn: Connection = {
        id: newId([]),
        serverUrl: legacyServer,
        name: hostName(legacyServer),
        token: legacyToken,
        user: legacyUser,
      };
      await setSecure(tokenKey(conn.id), legacyToken);
      await persist([conn], conn.id);
      await Promise.all([
        deleteSecure(LEGACY_TOKEN),
        removeItem(LEGACY_SERVER),
        removeItem(LEGACY_USER),
      ]);
      set({ connections: [conn], ...mirror([conn], conn.id) });
      return;
    }

    set({ status: 'unauthenticated' });
  },

  setSession: async ({ serverUrl, token, user, name }) => {
    const existing = get().connections;
    const prior = existing.find((c) => c.serverUrl === serverUrl);
    const id = prior?.id ?? newId(existing);
    const conn: Connection = {
      id,
      serverUrl,
      name: name ?? prior?.name ?? hostName(serverUrl),
      token,
      user,
    };
    const connections = prior ? existing.map((c) => (c.id === id ? conn : c)) : [...existing, conn];
    await setSecure(tokenKey(id), token);
    await persist(connections, id);
    set({ connections, pendingServerUrl: null, ...mirror(connections, id) });
    return id;
  },

  setPendingServerUrl: async (url) => set({ pendingServerUrl: url }),

  setUser: async (user) => {
    const { connections, activeConnectionId } = get();
    const next = connections.map((c) => (c.id === activeConnectionId ? { ...c, user } : c));
    await persist(next, activeConnectionId);
    set({ connections: next, ...mirror(next, activeConnectionId) });
  },

  setActiveConnection: async (id) => {
    const { connections } = get();
    if (!connections.some((c) => c.id === id)) return;
    await setItem(ACTIVE_KEY, id);
    set(mirror(connections, id));
  },

  reorderConnections: async (ids) => {
    const { connections, activeConnectionId } = get();
    const byId = new Map(connections.map((c) => [c.id, c]));
    const next = ids.map((id) => byId.get(id)).filter((c): c is Connection => c !== undefined);
    // Append any not named in ids (defensive).
    for (const c of connections) if (!ids.includes(c.id)) next.push(c);
    await persist(next, activeConnectionId);
    set({ connections: next, ...mirror(next, activeConnectionId) });
  },

  removeConnection: async (id) => {
    const { connections, activeConnectionId } = get();
    const next = connections.filter((c) => c.id !== id);
    const nextActive = activeConnectionId === id ? (next[0]?.id ?? null) : activeConnectionId;
    await deleteSecure(tokenKey(id));
    await persist(next, nextActive);
    set({ connections: next, ...mirror(next, nextActive) });
  },

  logout: async () => {
    const { activeConnectionId } = get();
    if (activeConnectionId) await get().removeConnection(activeConnectionId);
  },
}));
