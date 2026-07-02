import { Platform } from 'react-native';
import { create } from 'zustand';

import { ApiError, type ApiClient } from './client';

/**
 * Tracks whether the audiosilo server is currently reachable, so the sync layer
 * can stop hammering a dead endpoint (offline, or the server is LAN-only and you've
 * left wifi). Starts optimistic; flips to `false` when a request fails with a
 * connection error (a fetch rejection - no HTTP response), and back to `true` when
 * a lightweight probe succeeds or the browser reports it's back online. While
 * offline, progress/history saves queue locally instead of firing at the network;
 * registered reconnect handlers (e.g. queue flush) run when it recovers.
 */
type ReachabilityState = { online: boolean };

export const useReachability = create<ReachabilityState>(() => ({ online: true }));

let apiRef: ApiClient | null = null;
let probe: ReturnType<typeof setInterval> | null = null;
let probing = false;
const PROBE_MS = 20_000;
const reconnectHandlers = new Set<() => void>();

/** Point the reachability probe at the current client (set by ApiProvider). */
export function setReachabilityApi(api: ApiClient | null) {
  apiRef = api;
}
export function getReachabilityApi(): ApiClient | null {
  return apiRef;
}

export function isReachable(): boolean {
  return useReachability.getState().online;
}

/** Run `cb` whenever connectivity is restored. Returns an unsubscribe fn. */
export function onReconnect(cb: () => void): () => void {
  reconnectHandlers.add(cb);
  return () => reconnectHandlers.delete(cb);
}

function setOnline(online: boolean) {
  if (useReachability.getState().online === online) {
    if (!online) startProbe(); // already offline but make sure we're still probing
    return;
  }
  useReachability.setState({ online });
  if (online) {
    stopProbe();
    for (const cb of reconnectHandlers) cb();
  } else {
    startProbe();
  }
}

/**
 * Classify a thrown API error. An `ApiError` means the server answered (even a 500),
 * so it's reachable; a plain fetch rejection (or a `TimeoutError`) means it isn't.
 * Deliberate caller cancellations (`AbortError`) are ignored - only a `TimeoutError`,
 * not an `AbortError`, marks the server unreachable.
 */
export function noteError(e: unknown) {
  if (e instanceof ApiError) return setOnline(true);
  if (e instanceof Error && e.name === 'AbortError') return;
  setOnline(false);
}

/** A completed request proves the server is reachable. */
export function noteSuccess() {
  setOnline(true);
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

async function runProbe() {
  if (probing || !apiRef) return;
  probing = true;
  try {
    await apiRef.serverInfo();
    setOnline(true);
  } catch (e) {
    if (e instanceof ApiError) setOnline(true); // server answered → reachable
    // otherwise still unreachable; keep probing
  } finally {
    probing = false;
  }
}

// Web only: the browser's own connectivity signal flips state instantly (a probe
// confirms the server itself, not just the NIC). Native relies on the probe loop.
if (
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  window.addEventListener('online', () => void runProbe());
  window.addEventListener('offline', () => setOnline(false));
}
