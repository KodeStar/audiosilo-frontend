import { Platform } from 'react-native';
import { create } from 'zustand';

import { type Connection, onConnectionRemoved } from '@/stores/session';

import { type ApiClient, TimeoutError } from './client';
import { resolveClient } from './connection-clients';

/**
 * Per-connection reachability: tracks whether EACH signed-in server is currently
 * reachable, so the sync layer can stop hammering a dead endpoint (offline, or a
 * LAN-only server you've left) without penalising the others. The app is multi-server,
 * so "reachable" is a property of a connection, not a global. A connection with no
 * recorded state is assumed reachable (optimistic). A connection flips to `false` only
 * when a request (a query, a read, a save) got no answer and a check of its server
 * (`checkReachability`) got none either, and back to `true` when a lightweight probe of
 * that server succeeds, a save gets through, or the browser reports it's back online.
 * While a connection is offline its progress/history saves queue locally; registered
 * reconnect handlers run (per connection) on recovery.
 */
type ReachabilityState = { online: Record<string, boolean> };

export const useReachability = create<ReachabilityState>(() => ({ online: {} }));

// The live client map (set by ApiProvider), so the probe can reach any offline
// connection's server directly. With no provider mounted (the car's start without the
// React tree: Android's headless task, a CarPlay-first launch) it stays empty, and the probe
// builds the client from the session (`resolveClient`, on the address in use now) instead.
let clients: Map<string, ApiClient> = new Map();
let probe: ReturnType<typeof setInterval> | null = null;
let probing = false;
const PROBE_MS = 20_000;
const reconnectHandlers = new Set<(connectionId: string) => void>();
/** Each connection's check in flight (`checkReachability`, one at a time) and the client
 * it asks through. Removal drops the entry, so a check that outlives its connection
 * records nothing. */
const checking = new Map<string, ApiClient>();
/** How many answers each connection's server has given (every `setOnline(id, true)`), so
 * a check that got none can tell another request was answered while it waited. */
const answers = new Map<string, number>();
/** Connections whose check in flight must run again once it ends without an answer: a
 * query succeeded meanwhile (`recheckReachability`), so the check may be a stale one. */
const recheck = new Set<string>();

/** Point the reachability probe at the current set of clients (set by ApiProvider). */
export function setReachabilityClients(map: Map<string, ApiClient>) {
  clients = map;
}

/** Whether a connection is currently reachable (unknown → optimistic true). */
export function isReachable(connectionId: string): boolean {
  return useReachability.getState().online[connectionId] ?? true;
}

/** Whether ANY known connection is currently marked offline (for the aggregated banner). */
export function anyOffline(online: Record<string, boolean>): boolean {
  return Object.values(online).some((v) => !v);
}

export type ServerStatus = 'online' | 'offline' | 'reconnect';

/** One connection's state as the chrome shows it: it needs signing in again (the
 * reconnect flag wins - nothing syncs until then), it is unreachable, or it is fine. */
export function serverStatus(
  connection: Pick<Connection, 'id' | 'needsReconnect'>,
  online: Record<string, boolean>,
): ServerStatus {
  if (connection.needsReconnect) return 'reconnect';
  return online[connection.id] === false ? 'offline' : 'online';
}

/** The first of `connections` that is not answering (for the chrome that names it). */
export function firstOffline<C extends Pick<Connection, 'id' | 'needsReconnect'>>(
  connections: readonly C[],
  online: Record<string, boolean>,
): C | undefined {
  return connections.find((c) => serverStatus(c, online) === 'offline');
}

/** Run `cb(connectionId)` whenever a connection's connectivity is restored. Returns an
 * unsubscribe fn. */
export function onReconnect(cb: (connectionId: string) => void): () => void {
  reconnectHandlers.add(cb);
  return () => reconnectHandlers.delete(cb);
}

function setOnline(connectionId: string, online: boolean) {
  if (online) answers.set(connectionId, (answers.get(connectionId) ?? 0) + 1);
  const current = useReachability.getState().online;
  const prev = current[connectionId] ?? true;
  if (prev === online) {
    if (!online) startProbe(); // already offline but make sure we're still probing
    return;
  }
  const next = { ...current, [connectionId]: online };
  useReachability.setState({ online: next });
  if (online) {
    if (!anyOffline(next)) stopProbe();
    for (const cb of reconnectHandlers) cb(connectionId);
  } else {
    startProbe();
  }
}

/** Whether a failed request got no answer from its server: our timeout, or the fetch
 * itself rejecting (a `TypeError`: "Failed to fetch", "Network request failed"). Strict,
 * so a caller that sees every kind of failure (the query cache) never reads a capability
 * gate or a cancelled read as a dead server. */
function isUnreachableError(e: unknown): boolean {
  return e instanceof TimeoutError || e instanceof TypeError;
}

/**
 * A request of `connectionId` failed with `e` (a query, a read with a local fallback, a
 * progress save, a listening span). No answer (`isUnreachableError`) has the server
 * checked (`checkReachability`) unless it is already marked down (the probe watches it
 * then): only the check marks it down, so one slow or broken request alone never does
 * (frontend#131). Anything else says nothing.
 */
export function noteFailure(connectionId: string, e: unknown): void {
  if (isUnreachableError(e) && isReachable(connectionId)) void checkReachability(connectionId);
}

/** A completed request proves that connection's server is reachable. */
export function noteSuccess(connectionId: string) {
  setOnline(connectionId, true);
}

function startProbe() {
  if (!probe) probe = setInterval(() => void runProbe(), PROBE_MS);
}
function stopProbe() {
  if (probe) {
    clearInterval(probe);
    probe = null;
  }
}

/** The client a connection's requests go through now: the provider's, else one built from
 * the session (on the address in use now). Null once the connection is gone. */
function clientFor(connectionId: string): ApiClient | null {
  return clients.get(connectionId) ?? resolveClient(connectionId);
}

/**
 * Ask one connection's server whether it answers (`GET /server`: public and cheap) and
 * record what that says: an answer (any status) is reachable, no answer is not. One check
 * per connection at a time.
 *
 * It is also how a query's outcome reaches this state (frontend#131): a query that got no
 * answer, or one that succeeded while its server is marked down, only asks for a check,
 * never sets the state itself. So one slow or broken query (a long read past its timeout,
 * a code bug's `TypeError`) cannot mark a healthy server down, and a query answered from
 * a local copy cannot mark a dead one up, either of which would flap the offline banner,
 * the reconnect refetch and (native) the address re-pick. For the same reason a check
 * records nothing once it is stale: its connection was removed, or moved to another
 * address (home / away), while it waited, and a check that got no answer leaves alone a
 * server another request was answered by meanwhile (the check can wait out its whole
 * timeout on a request sent before the network came back).
 */
export async function checkReachability(connectionId: string): Promise<void> {
  if (checking.has(connectionId)) return;
  const client = clientFor(connectionId);
  if (!client) return; // connection gone; removal purges its state
  checking.set(connectionId, client);
  const answersBefore = answers.get(connectionId) ?? 0;
  let answered = true;
  try {
    await client.serverInfo();
  } catch (e) {
    answered = !isUnreachableError(e); // an `ApiError` is an answer, whatever its status
  }
  // Removed while it ran (removal drops its entry): nothing to record.
  if (checking.get(connectionId) !== client) return;
  checking.delete(connectionId);
  const again = recheck.delete(connectionId);
  const now = clientFor(connectionId);
  if (now && now.baseUrl === client.baseUrl) {
    if (answered) setOnline(connectionId, true);
    else if ((answers.get(connectionId) ?? 0) === answersBefore) setOnline(connectionId, false);
  }
  // A query succeeded while this one waited (a Retry that got through, a check sent before
  // the network came back): ask again now, not at the next probe.
  if (again && !isReachable(connectionId)) void checkReachability(connectionId);
}

/** `checkReachability` for a query that succeeded while its server is marked down: when
 * a check is already on its way (it may have been sent before the network came back),
 * it runs once more after that one, so the success is never lost to a stale check. */
export function recheckReachability(connectionId: string): void {
  if (checking.has(connectionId)) recheck.add(connectionId);
  else void checkReachability(connectionId);
}

/** Probe every currently-offline connection's server; mark those that answer online.
 * The probes run concurrently (disjoint servers), so one slow/dead server can't delay
 * another's recovery. */
async function runProbe() {
  if (probing) return;
  const offline = Object.entries(useReachability.getState().online)
    .filter(([, v]) => !v)
    .map(([cid]) => cid);
  if (offline.length === 0) {
    stopProbe();
    return;
  }
  probing = true;
  try {
    await Promise.all(offline.map(checkReachability));
  } finally {
    probing = false;
  }
}

// A removed connection's reachability entry must be dropped, or a stale `false` would
// keep `anyOffline` true (banner stuck) and the probe loop spinning on a client that no
// longer exists.
onConnectionRemoved((id) => {
  checking.delete(id);
  answers.delete(id);
  recheck.delete(id);
  const current = useReachability.getState().online;
  if (!(id in current)) return;
  const { [id]: _drop, ...rest } = current;
  useReachability.setState({ online: rest });
  if (!anyOffline(rest)) stopProbe();
});

// Web only: the browser's own connectivity signal flips state instantly (a probe
// confirms each server itself, not just the NIC). `offline` marks every known
// connection down; `online` re-probes them. Native relies on the probe loop.
if (
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  window.addEventListener('online', () => void runProbe());
  window.addEventListener('offline', () => {
    for (const cid of clients.keys()) setOnline(cid, false);
  });
}
