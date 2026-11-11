import * as Network from 'expo-network';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * Whether the device itself has a network (CONNECT-15): the browser's `navigator.onLine`
 * on the web, the system's network state in the app. With a network, a server that doesn't
 * answer is that server's trouble, and the chrome names it ("Hearthside isn't answering");
 * without one, the device is offline. Unknown counts as online (a state not yet known, a
 * probe that failed, a network the system can't name, a test), so the server is named
 * rather than the device blamed. One
 * subscription to the system serves every caller (`subscribe`).
 *
 * In the app "a network" is the system's `isConnected` alone, never whether the internet
 * can be reached through it (fe#179): a server on the same Wi-Fi answers with the
 * internet down, so whether a server can be reached is that server's to say (by
 * answering), and a Retry stays on screen. React Query pauses its reads by the same
 * signal in the app (`watchDeviceOnline`, wired in `src/api/provider.tsx`; writes are
 * never held there), and the API client fails a request at once, unsent, while it reads
 * false (`ApiClient.send`).
 */
export function useDeviceOnline(): boolean {
  return useSyncExternalStore(subscribe, readOnline, readOnline);
}

/**
 * The same signal outside React: `listener` hears the state now and at every change, until
 * the returned stop is called. The shape of TanStack's `onlineManager.setEventListener`
 * setup, so the query library pauses and resumes its reads by what `useDeviceOnline` shows.
 */
export function watchDeviceOnline(listener: (online: boolean) => void): () => void {
  const stopWatching = subscribe(() => listener(online));
  listener(online);
  return stopWatching;
}

/**
 * The same signal read once, outside React (a start of a download offline, `playBook`): what
 * the system said last in the app (the query wiring always watches it there), the browser's
 * `navigator.onLine` on the web (what a watch there follows). Unknown counts as online.
 */
export function isDeviceOnline(): boolean {
  if (Platform.OS !== 'web') return online;
  return typeof navigator === 'undefined' || navigator.onLine !== false;
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
  // Offline only when the system says there is no network. A network it can't name (type
  // `UNKNOWN`: Android reports `isConnected: false` for a transport it doesn't know, and
  // for a state it failed to read) is unknown, so online: every query waits on this flag.
  const apply = (s: Network.NetworkState | undefined) => {
    if (live && s) setOnline(s.isConnected !== false || (s.type as string) === 'UNKNOWN');
  };
  let sub: { remove: () => void } | undefined;
  // The first read can land after a change the listener already told (iOS answers it
  // after up to 5 s, and "not connected" when that runs out): the change is the newer.
  let heard = false;
  try {
    Promise.resolve(Network.getNetworkStateAsync()).then(
      (s) => {
        if (!heard) apply(s);
      },
      () => undefined,
    );
    sub = Network.addNetworkStateListener((s) => {
      heard = true;
      apply(s);
    });
  } catch {
    // No network module (a test, a platform without one): stay "online".
  }
  return () => {
    live = false;
    if (typeof sub?.remove === 'function') sub.remove();
  };
}
