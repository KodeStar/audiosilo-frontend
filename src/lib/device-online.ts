import * as Network from 'expo-network';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * Whether the device itself has a network (CONNECT-15): the browser's `navigator.onLine`
 * on the web, the system's network state in the app. With a network, a server that doesn't
 * answer is that server's trouble, and the chrome names it ("Hearthside isn't answering");
 * without one, the device is offline. Unknown counts as online (an iOS reachability not
 * yet known, a probe that failed, a test), so the server is named rather than the device
 * blamed. One subscription to the system serves every caller (`subscribe`).
 */
export function useDeviceOnline(): boolean {
  return useSyncExternalStore(subscribe, readOnline, readOnline);
}

let online = true;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

function readOnline(): boolean {
  return online;
}

function setOnline(next: boolean): void {
  if (next === online) return;
  online = next;
  for (const l of listeners) l();
}

/** The first caller starts listening to the system, the last one to leave stops it. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) stop = listen();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = undefined;
    }
  };
}

function listen(): () => void {
  if (Platform.OS === 'web') {
    if (
      typeof window === 'undefined' ||
      typeof navigator === 'undefined' ||
      typeof window.addEventListener !== 'function'
    )
      return () => undefined;
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }
  let live = true;
  const apply = (s: Network.NetworkState | undefined) => {
    if (live && s) setOnline(s.isConnected !== false && s.isInternetReachable !== false);
  };
  let sub: { remove: () => void } | undefined;
  try {
    Promise.resolve(Network.getNetworkStateAsync()).then(apply, () => undefined);
    sub = Network.addNetworkStateListener(apply);
  } catch {
    // No network module (a test, a platform without one): stay "online".
  }
  return () => {
    live = false;
    if (typeof sub?.remove === 'function') sub.remove();
  };
}
