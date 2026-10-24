import { Platform } from 'react-native';
import { create } from 'zustand';

import { type Connection, onConnectionRemoved } from '@/stores/session';

import { ApiError, type ApiClient, TimeoutError } from './client';
import { resolveClient } from './connection-clients';

/**
 * Per-connection reachability: tracks whether EACH signed-in server is currently
 * reachable, so the sync layer can stop hammering a dead endpoint (offline, or a
 * LAN-only server you've left) without penalising the others. The app is multi-server,
 * so "reachable" is a property of a connection, not a global. A connection with no
 * recorded state is assumed reachable (optimistic). A connection flips to `false` when
 * one of its requests fails with a connection error (a fetch rejection - no HTTP
 * response), and back to `true` when a lightweight probe of that server succeeds or the
 * browser reports it's back online. While a connection is offline its progress/history
 * saves queue locally; registered reconnect handlers run (per connection) on recovery.
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

/**
 * Classify a thrown API error for a connection. An `ApiError` means the server answered
 * (even a 500), so it's reachable; a plain fetch rejection (or a `TimeoutError`) means it
 * isn't. Deliberate caller cancellations (`AbortError`) are ignored - only a
 * `TimeoutError`, not an `AbortError`, marks the server unreachable.
 */
export function noteError(connectionId: string, e: unknown) {
  if (e instanceof ApiError) return setOnline(connectionId, true);
  if (e instanceof Error && e.name === 'AbortError') return;
  setOnline(connectionId, false);
}

/** Whether a failed request got no answer from its server: our timeout, or the fetch
 * itself rejecting (a `TypeError`: "Failed to fetch", "Network request failed"). The
 * strict test for a caller that sees every kind of failure (the query cache), where
 * `noteError`'s "anything that is not an `ApiError`" would read a capability gate or a
 * cancelled read as a dead server. */
export function isUnreachableError(e: unknown): boolean {
  return e instanceof TimeoutError || e instanceof TypeError;
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

const checking = new Set<string>();

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
 * the reconnect refetch and (native) the address re-pick.
 */
export async function checkReachability(connectionId: string): Promise<void> {
  if (checking.has(connectionId)) return;
  const client = clients.get(connectionId) ?? resolveClient(connectionId);
  if (!client) return; // connection gone; removal purges its state
  checking.add(connectionId);
  let answered = true;
  try {
    await client.serverInfo();
  } catch (e) {
    answered = e instanceof ApiError || !isUnreachableError(e);
  } finally {
    checking.delete(connectionId);
  }
  if (answered) setOnline(connectionId, true);
  // Removed while the check ran: a stale `false` would keep the banner up and the probe
  // spinning (a stale `true` is harmless).
  else if (clients.has(connectionId) || resolveClient(connectionId)) setOnline(connectionId, false);
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
