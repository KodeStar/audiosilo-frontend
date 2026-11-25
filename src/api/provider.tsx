import {
  onlineManager,
  type Query,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { connectionIdFromKey, isServerInfoKey, serverInfoKey } from '@/lib/auth-failure';
import {
  connectionSetFor,
  type ProxyHeaders,
  type ProxySets,
  proxyOriginChoices,
  sameProxyHeaders,
  type SignInProxySet,
} from '@/lib/proxy-headers';
import { watchDeviceOnline } from '@/lib/device-online';
import { flushConnection } from '@/playback/progress-sync';
import { flushReadingConnection } from '@/reader/reading-progress';
import { connectionsOfProfile, useProfiles, visibleConnectionIds } from '@/stores/profiles';
import {
  onConnectionRemoved,
  onConnectionRenamed,
  useSession,
  type Connection,
} from '@/stores/session';

import { pickedUrl, useAddressRoute } from './address-route';
import { type ApiClient, isNotInLibraryError, isProxyRefusal, isSignedOutError } from './client';
import { connectionClient, readKnownCapabilitiesFrom } from './connection-clients';
import {
  moveProxyRefusal,
  noteNewToken,
  noteProxyAnswer,
  onProxyRefusalsOver,
} from './proxy-refusal';
import {
  anyOffline,
  noteFailure,
  noteSuccess,
  onReconnect,
  recheckReachability,
  setReachabilityClients,
  useReachability,
} from './reachability';
import * as startupCache from './startup-cache';
import type { ServerInfo } from './types';

// --- Dead-token / server-reset detection -----------------------------------------------
// Dead-token detection (a 401 on an authenticated request ⇒ re-pair) rides on the
// ApiClient itself: each per-connection client is built with an `onAuthError` callback
// that flags ITS connection, so EVERY request path - queries, mutations, and the
// framework-free progress-sync save loop - inherits detection at one choke point. A
// connection client also verifies the address and identity of its /server answers.

/** A successful AUTHENTICATED query for a connection proves its token is alive - clear any
 * flag. The public `/server` query is skipped because its success proves nothing about the token. */
function noteQuerySuccess(key: readonly unknown[]) {
  noteQueryReached(key);
  // The connection client already checked this public answer's address and identity.
  if (isServerInfoKey(key)) return;
  // Hot path: fires on EVERY successful fetch, so bail before allocating when nothing
  // is flagged (the overwhelmingly common case) - clearNeedsReconnect would just no-op.
  const { connections, clearNeedsReconnect } = useSession.getState();
  if (!connections.some((c) => c.needsReconnect)) return;
  const cid = cidOfKey(key);
  if (cid) clearNeedsReconnect(cid);
}

/** The connection a query key belongs to, among the signed-in ones. */
function cidOfKey(key: readonly unknown[]): string | null {
  return connectionIdFromKey(
    key,
    useSession.getState().connections.map((c) => c.id),
  );
}

/**
 * A query that could not reach its server (no answer: the fetch failed or timed out) has
 * the server checked (`noteFailure`): only a `/server` that does not answer either
 * marks the connection unreachable, so the chrome names it, the probe watches for it, and
 * its queries refetch once it is back (`onReconnect`, below; frontend#131). One slow or
 * broken query alone never does. An answer (an `ApiError`, a 401 included) or anything
 * else (a capability gate, a cancel) says nothing about reachability.
 */
function noteQueryError(error: unknown, key: readonly unknown[]) {
  const cid = cidOfKey(key);
  if (cid) noteFailure(cid, error);
}

/** A query that succeeded for a server marked down has it checked at once, so a Retry
 * that got through brings the connection back now, not at the next probe. Checked, not
 * trusted: a query can succeed from a local copy (`fetchBookProgress`'s mirror). The
 * public `/server` query is that check's own request, so its success is the answer
 * itself. Bails first when nothing is down (every successful fetch runs it). */
function noteQueryReached(key: readonly unknown[]) {
  const { online } = useReachability.getState();
  if (!anyOffline(online)) return;
  const cid = cidOfKey(key);
  if (!cid || online[cid] !== false) return;
  if (!isServerInfoKey(key)) {
    recheckReachability(cid);
    return;
  }
  // The reconnect it brings (`onReconnect`, below) reads the connection's queries again, all
  // but this `/server` that has just answered (fe#147).
  noteSuccess(cid, key);
}

/**
 * The default query retry: once, except a 401 (frontend#124) or content that isn't there
 * (`isNotInLibraryError`: a 404, 403 or 400, CONNECT-13). A refused token stays refused
 * (the client has already flagged its connection for reconnect, and the screens show one
 * sign-in state for it), and a missing book stays missing, so asking again only doubles
 * every dead request.
 */
export function retryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && !isSignedOutError(error) && !isNotInLibraryError(error);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // Dead-token flagging lives on the ApiClient callback (one choke point for every
    // request path). The cache keeps what a per-call callback can't do: clearing a flag,
    // and telling reachability what a query learnt.
    // A query that reads only this device (`meta.local`: the calendar link's copy) says
    // nothing about the server: it neither clears a reconnect flag nor marks it reached.
    onSuccess: (_data, query) => {
      if (query.meta?.local !== true) noteQuerySuccess(query.queryKey);
    },
    onError: (error, query) => noteQueryError(error, query.queryKey),
  }),
  defaultOptions: {
    queries: {
      retry: retryQuery,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    // The app: a write is sent whatever the online flag says, as it was before the flag
    // followed the network there (below). Held for the network it never settles: Save
    // spins, and the write, which lives only in memory, is gone if the app is closed
    // before the network returns. Sent, it fails at once with no network (the client
    // refuses it unsent, `ApiClient.send`) and the screen says so (its own error, the form
    // still open). The web keeps TanStack's default (a
    // write waits for the browser to come back online), as it always has.
    mutations: Platform.OS === 'web' ? undefined : { networkMode: 'always' },
  },
});

// A connection's client reads its server's flags from the cache's `/server` answer (seeded
// at launch from the kept copy, `server-snapshots.ts`), to tell whose a 401 is
// (`unauthorized_mark`): a read of what is held, never a request.
readKnownCapabilitiesFrom(
  (cid) => queryClient.getQueryData<ServerInfo>(serverInfoKey(cid))?.capabilities,
);

// React Query's online flag follows the signal `useDeviceOnline` shows (fe#179). With no
// network a query waits (`paused`) and is asked as soon as the network is back, where it
// used to fail at once and stay failed; a read that must settle either way asks with
// `networkMode: 'always'` (`fetchFailFast`, the reads of this device).
// - The app: the system's network state. Only reads wait: a write is never held (the
//   `mutations` default above). "A network" is the system's `isConnected`, so a server on
//   the same Wi-Fi is still asked with the internet down.
// - The web: the browser's `navigator.onLine`, read at start and then on its `online` /
//   `offline` events. TanStack's own listener hears only the events and starts online, so
//   a cold launch with no network asked every read and failed it, and a screen that mounts
//   a reader of a failed read asked it again, over and over (fe#271).
onlineManager.setEventListener(watchDeviceOnline);

// Web: paint the first screens from the last visit's answers while they are asked again
// (`startup-cache.ts`); before anything renders, so the first render already has them. A
// kept answer whose server refuses the token goes (the screen shows the sign-in state), and
// only the signed-in connections' answers are written.
startupCache.restore(queryClient, { dropOnError: isSignedOutError });
startupCache.startSaving(queryClient, (key) => cidOfKey(key) !== null);

// Evict the removed server's cached data (every query key leads with its connection
// id). Matching by `includes(id)` could in theory also match a same-string path
// segment, but that would only evict one extra entry - harmless, it just refetches.
onConnectionRemoved((id) => {
  queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(id) });
  startupCache.forget(id);
  // A proxy's refusals of it end with it (`ProxyRefusedBanner`).
  noteProxyAnswer(id, false);
});
// Another tab's identity migration renamed it: a proxy's refusals of it go on under the new id.
onConnectionRenamed(moveProxyRefusal);
// Signed in again: a 401 refusal of the old token says nothing of the new one (`noteNewToken`).
useSession.subscribe((state, prev) => {
  if (state.connections === prev.connections) return;
  for (const c of state.connections) {
    const was = prev.connections.find((p) => p.id === c.id);
    if (was && was.token !== c.token) noteNewToken(c.id);
  }
});

/** A failed /server with no observers cannot refetch when connectivity or credentials
 * change. Drop that failure so the next gate mounting gets its first read. */
function forgetUnobservedServerFailure(cid: string) {
  const key = serverInfoKey(cid);
  const q = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  if (!q || q.getObserversCount() > 0 || q.state.status !== 'error') return;
  if (q.state.data === undefined) {
    queryClient.removeQueries({ queryKey: key, exact: true });
  } else {
    // Keep the last answer at its original age. The invalidation that follows allows
    // the next observer to refresh it on the recovered connection.
    queryClient.setQueryData(key, q.state.data, { updatedAt: q.state.dataUpdatedAt });
  }
}

/** Every signed-in connection's failed, unobserved /server, before the app's foreground
 * refresh: invalidating one with no data does not make its next observer ask, as
 * `serverInfoQuery` keeps a failed read from being asked again on every mount. */
export function forgetUnobservedServerFailures(): void {
  for (const c of useSession.getState().connections) forgetUnobservedServerFailure(c.id);
}

// An authenticated answer can prove the proxy lets this device through again even
// when its headers and the device's network stayed the same.
onProxyRefusalsOver((cid) => {
  const key = serverInfoKey(cid);
  if (!isProxyRefusal(queryClient.getQueryState(key)?.error)) return;
  forgetUnobservedServerFailure(cid);
  void queryClient.invalidateQueries({ queryKey: key, exact: true });
});

/** A book's read-along map that is in (`qk.readalong`, `qk.readalongLocal`): keyed by its
 * `generated_at`, so the copy held is that very map after any reconnect, and reading up to
 * 16 MiB again would change nothing. One that failed is read again like any query. */
function isHeldReadalongMap(q: Query): boolean {
  const kind = q.queryKey[0];
  return (kind === 'readalong' || kind === 'readalongLocal') && q.state.status === 'success';
}

// When a connection becomes reachable again, refetch that connection's queries (so
// screens that errored or emptied while it was offline repopulate on their own) and
// replay its queued progress saves (and its queued ebook reading places). invalidateQueries only refetches currently-observed
// queries, so this is cheap; every query key leads with its connection id, so the
// predicate scopes the refetch to the recovered server. A read-along map held is kept, and
// so is the `/server` answer that brought the server back (`answeredQuery`).
onReconnect((connectionId, answeredQuery) => {
  forgetUnobservedServerFailure(connectionId);
  void queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey.includes(connectionId) && !isHeldReadalongMap(q) && q.queryKey !== answeredQuery,
  });
  void flushConnection(connectionId);
  void flushReadingConnection(connectionId);
});

type ApiRegistry = {
  clients: Map<string, ApiClient>;
  connections: Connection[];
};

const ApiContext = createContext<ApiRegistry>({
  clients: new Map(),
  connections: [],
});

/** A connection paired with its API client. */
export type ApiConnection = { connection: Connection; client: ApiClient };

/** A connection's client and the address, token and proxy headers it was built with. */
type BuiltClient = {
  url: string;
  token: string;
  proxyHeaders: ProxyHeaders | null;
  client: ApiClient;
};

/**
 * Each connection's client on the address it uses now (`pickedUrl`), reusing the one in
 * `previous` while its address, token and the proxy headers it sends there (`sets`, fe#295, or
 * its sign-in's own, `own`, `connectionSetFor`) are unchanged, so a switch of one connection's address (home / away) rebuilds only
 * that connection's client: every memo keyed on another connection's client (the Journal's
 * per-server queries, a capability query's function) and its in-flight reachability probe
 * survive.
 */
export function buildClients(
  connections: readonly Connection[],
  picks: Record<string, string>,
  previous: ReadonlyMap<string, BuiltClient>,
  sets: ProxySets,
  own: Readonly<Record<string, SignInProxySet>> = {},
): Map<string, BuiltClient> {
  const built = new Map<string, BuiltClient>();
  for (const c of connections) {
    const url = pickedUrl(c, picks[c.id]);
    const proxyHeaders = connectionSetFor(sets, url, own[c.id]);
    const kept = previous.get(c.id);
    built.set(
      c.id,
      kept &&
        kept.url === url &&
        kept.token === c.token &&
        sameProxyHeaders(kept.proxyHeaders, proxyHeaders)
        ? kept
        : {
            url,
            token: c.token,
            proxyHeaders,
            // Built on the address in use now, as `resolveClient` builds its own.
            client: connectionClient(c, url, proxyHeaders),
          },
    );
  }
  return built;
}

/** The clients built last, by connection id: a cache (a client is a stateless holder of
 * its address and token, so handing the same one to another provider is harmless). */
const lastBuilt = new Map<string, BuiltClient>();

/** `buildClients` against the clients built last, which it then replaces. */
function connectionClients(
  connections: readonly Connection[],
  picks: Record<string, string>,
  sets: ProxySets,
  own: Readonly<Record<string, SignInProxySet>>,
): Map<string, ApiClient> {
  const built = buildClients(connections, picks, lastBuilt, sets, own);
  lastBuilt.clear();
  for (const [id, b] of built) lastBuilt.set(id, b);
  return new Map([...built].map(([id, b]) => [id, b.client]));
}

/** The lists a screen reads first for a connection (kids mode's shelf, the Household card's
 * library pick): read again with a new token even when their last answer was fine. */
const READ_AGAIN_ON_SIGN_IN = new Set(['server', 'libraries', 'collections']);

/** Whether `query`, of connection `cid` (every key carries it, though not always second),
 * is read again once that connection has a new token: whatever failed while it was signed
 * out, and the lists screens read first. */
export function readAgainOnSignIn(query: Pick<Query, 'queryKey' | 'state'>, cid: string): boolean {
  if (!query.queryKey.includes(cid)) return false;
  return query.state.status === 'error' || READ_AGAIN_ON_SIGN_IN.has(String(query.queryKey[0]));
}

async function refreshWithNewCredentials(cid: string) {
  // Invalidation joins an initial request with no data, even with cancelRefetch.
  // Cancel that request first so its late refusal cannot become the new sign-in's.
  await queryClient.cancelQueries({
    queryKey: serverInfoKey(cid),
    exact: true,
    predicate: (q) => q.state.data === undefined && q.state.fetchStatus !== 'idle',
  });
  forgetUnobservedServerFailure(cid);
  await queryClient.invalidateQueries({ predicate: (q) => readAgainOnSignIn(q, cid) });
}

/**
 * Read a connection's answers again once it has a new token (signed in again: the
 * Household page's "Sign in again", the connect flow's reconnect) or new proxy headers
 * (fe#167, the Account page): what failed while it was signed out, or while the proxy
 * turned it away, would otherwise keep its error until a reload (`readAgainOnSignIn`). In
 * the provider's effect, which runs after every screen's own: the queries already hold the
 * new client (`useApiRegistry`) by then, and a read any earlier would ask with the dead
 * token and flag the connection again.
 */
function useReadAgainOnSignIn(connections: readonly Connection[], sets: ProxySets) {
  const tokens = useRef(new Map<string, { token: string; proxy: string }>());
  useEffect(() => {
    const seen = tokens.current;
    for (const c of connections) {
      const before = seen.get(c.id);
      const proxy = proxySetsText(c, sets);
      seen.set(c.id, { token: c.token, proxy });
      if (before === undefined || (before.token === c.token && before.proxy === proxy)) {
        continue;
      }
      void refreshWithNewCredentials(c.id);
    }
    for (const id of seen.keys()) {
      if (!connections.some((c) => c.id === id)) seen.delete(id);
    }
  }, [connections, sets]);
}

/** The proxy headers kept for each of a connection's addresses, as one comparable text. */
function proxySetsText(c: Connection, sets: ProxySets): string {
  return JSON.stringify(proxyOriginChoices(c).map((o) => sets[o] ?? null));
}

/**
 * Ask a connection's failed `/server` again once its client moved to another address (the
 * address runner's home / away pick): that failure (another host at home, an answer from
 * the address it left, no answer) says nothing of the new address, and nothing else asks
 * it again (`serverInfoQuery` keeps a failure from every screen mounting, and reachability
 * takes another host's answer as none). In the provider's effect, after every screen's
 * own, so the read goes out through the new client.
 */
function useReadServerAgainOnMove(clients: ReadonlyMap<string, ApiClient>) {
  const urls = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = urls.current;
    for (const [cid, client] of clients) {
      const before = seen.get(cid);
      seen.set(cid, client.baseUrl);
      if (before === undefined || before === client.baseUrl) continue;
      const key = serverInfoKey(cid);
      if (queryClient.getQueryState(key)?.status !== 'error') continue;
      forgetUnobservedServerFailure(cid);
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    }
    for (const id of seen.keys()) {
      if (!clients.has(id)) seen.delete(id);
    }
  }, [clients]);
}

export function ApiProvider({ children }: { children: ReactNode }) {
  const connections = useSession((s) => s.connections);
  // Every origin's proxy headers (fe#295): an edit rebuilds the clients on that origin.
  const proxySets = useSession((s) => s.proxySets);
  // A sign-in's own set, where it uses one in place of the kept set (`signInProxySets`).
  const ownSets = useSession((s) => s.signInProxySets);
  // Which of each connection's addresses (home / away) requests go to right now.
  const picks = useAddressRoute((s) => s.picks);

  // Build the clients only when the connections, the picked addresses or the proxy headers
  // change, and then only the ones whose address, token or set moved (`buildClients`) -
  // re-creating a client drops its in-flight reachability probe and force-refetches its
  // queries.
  const clients = useMemo(
    () => connectionClients(connections, picks, proxySets, ownSets),
    [connections, picks, proxySets, ownSets],
  );

  const registry = useMemo<ApiRegistry>(() => ({ clients, connections }), [clients, connections]);

  // Give the reachability layer every connection's client, so it can probe any offline
  // server (not just the active one) and recover them independently.
  useEffect(() => {
    setReachabilityClients(registry.clients);
  }, [registry]);
  useReadAgainOnSignIn(connections, proxySets);
  useReadServerAgainOnMove(clients);

  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={registry}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

export function useApiRegistry(): ApiRegistry {
  return useContext(ApiContext);
}

/** The default connection id (`''` when none) - the fallback cid for chrome that isn't
 * scoped to a specific server (the top bar, the connect flow default). Internal to the
 * cid resolution order (`useCid`); consumers should use `useCid()`, not the raw default. */
function useDefaultCid(): string {
  return useSession((s) => s.defaultConnectionId) ?? '';
}

/**
 * The connection a subtree of content is scoped to (the server whose library/book you
 * are viewing), supplied by the `(app)` layout via `ConnectionScope` from the content
 * route's `?connection=` query param. `''` outside any scope (chrome, aggregated
 * Home/Search). Content screens read the scope instead of the global default connection.
 */
const ConnectionScopeContext = createContext<string>('');

/** Wrap a subtree so its content hooks resolve to `connectionId` (`ContentScope`, from the
 * content route's `?connection=` query param; Home's cards, from their book's). Nothing
 * while that connection is not signed in: a subtree can outlive it for a render (the
 * player's book through a connection another tab removed, until its stop lands), and its
 * hooks would throw (`useApi`). `keepWhenGone`: the subtree all the same, for content that
 * asks only through `useOptionalApi` and says itself the server isn't connected (the
 * companion and its Text chip: a download plays on without its connection). */
export function ConnectionScope({
  connectionId,
  keepWhenGone = false,
  children,
}: {
  connectionId: string;
  keepWhenGone?: boolean;
  children: ReactNode;
}) {
  const { clients } = useContext(ApiContext);
  if (connectionId && !keepWhenGone && !clients.has(connectionId)) return null;
  return (
    <ConnectionScopeContext.Provider value={connectionId}>
      {children}
    </ConnectionScopeContext.Provider>
  );
}

/** The nearest route scope's connection id, or `''` outside any scope. */
export function useScopedCid(): string {
  return useContext(ConnectionScopeContext);
}

/**
 * The connection id to use for content: an explicit `connectionId` wins (a card passing
 * its own server), else the nearest route scope, else the default connection. One
 * definition so the resolution order can't drift across call sites.
 */
export function useCid(connectionId?: string): string {
  const scope = useScopedCid();
  const fallback = useDefaultCid();
  return connectionId ?? (scope || fallback);
}

/** The ApiClient for a connection (explicit id → route scope → default). Throws if none. */
export function useApi(connectionId?: string): ApiClient {
  const { clients } = useContext(ApiContext);
  const cid = useCid(connectionId);
  const client = clients.get(cid) ?? null;
  if (!client) {
    throw new Error('useApi() requires a configured server connection');
  }
  return client;
}

/** Like useApi but returns null instead of throwing (explicit id → route scope → default). */
export function useOptionalApi(connectionId?: string): ApiClient | null {
  const { clients } = useContext(ApiContext);
  const cid = useCid(connectionId);
  return clients.get(cid) ?? null;
}

/** Every connection of the person listening (the active profile's, Phase 8) paired with
 * its client, in user-defined order: what every aggregated screen shows (Home, Search,
 * the Library picker, You, the Journal). Background work never comes through here; it
 * resolves its own connection (`resolveClient`). The same array while the connections,
 * the clients and the profile's connections are (callers memoise on it: the Journal's
 * per-server queries and their merge). */
export function useApis(): ApiConnection[] {
  const { clients, connections } = useContext(ApiContext);
  // None while someone must be chosen (`mustChoose`): nothing of anyone shows.
  const ids = useProfiles(visibleConnectionIds);
  return useMemo(
    () =>
      connectionsOfProfile(connections, ids)
        .map((connection) => {
          const client = clients.get(connection.id);
          return client ? { connection, client } : null;
        })
        .filter((x): x is ApiConnection => x !== null),
    [clients, connections, ids],
  );
}
