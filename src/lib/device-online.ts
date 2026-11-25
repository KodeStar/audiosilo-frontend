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
 * signal on every platform (`watchDeviceOnline`, wired in `src/api/provider.tsx`; writes
 * are never held in the app), and the API client fails a request at once, unsent, while it
 * reads false (`ApiClient.send`).
 */
export function useDeviceOnline(): boolean {
  return useSyncExternalStore(subscribe, readOnline, readOnlineAtBuild);
}

/** What the web's static pages were rendered with (no browser there, so online): read
 * while they hydrate, so an offline start doesn't contradict them (the query wiring reads
 * the browser's flag at start, before anything hydrates); the real one follows at once. */
function readOnlineAtBuild(): boolean {
  return true;
}

/**
 * The same signal outside React: `listener` hears the state now and at every change, until
 * the returned stop is called. The shape of TanStack's `onlineManager.setEventListener`
 * setup, so the query library pauses and resumes its reads by what `useDeviceOnline` shows.
 */
export function watchDeviceOnline(listener: (online: boolean) => void): () => void {
  let last: boolean | undefined;
  const update = () => {
    const next = readOnline();
    if (last === next) return;
    last = next;
    listener(next);
  };
  const stopWatching = subscribe(update);
  update();
  return stopWatching;
}

/**
 * The same signal read once, outside React (a start of a download offline, `playBook`): what
 * the system said last in the app (the query wiring always watches it there), the browser's
 * `navigator.onLine` on the web. Undefined means the native network is still unknown.
 */
export function isDeviceOnline(): boolean | undefined {
  if (Platform.OS !== 'web') return online;
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

let online: boolean | undefined;
let monitorOffline = false;
/** How many HTTP answers have confirmed a network (`deviceNetworkAnswered`): a reading
 * only gives way to one that came while it was running, never to an older one. */
let answers = 0;
let firstRead: Promise<void> | undefined;
let finishFirstRead: (() => void) | undefined;
// A cold car start also has to load the book within the head unit's deadline.
const FIRST_READ_MS = 750;
// expo-network's getNetworkPathAsync returns NONE when this native timeout expires.
const IOS_PROBE_TIMEOUT_MS = 5000;

/** A downloaded book can use its own files while the network is unknown. All starts
 * share the same short wait, including a direct player start with no mounted screen. */
export async function waitForDeviceOnline(): Promise<boolean | undefined> {
  const known = isDeviceOnline();
  if (known !== undefined) return known;
  const off = subscribe(() => {});
  try {
    await firstRead;
    return online;
  } finally {
    off();
  }
}

/** An actual native response can correct the startup probe. A newer offline monitor
 * event wins over an in-flight request finishing as the network goes away. */
export function deviceNetworkAnswered(): void {
  if (Platform.OS !== 'web' && !monitorOffline) {
    answers++;
    setOnline(true);
    finishFirstRead?.();
  }
}
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

function readOnline(): boolean {
  return online !== false;
}

function setOnline(next: boolean | undefined): void {
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
  let heard = false;
  const started = performance.now();
  // An answer while nothing watched (the app's screen gone, playback going on) left a "yes"
  // no one checks since: this reading's probe still applies over it.
  const answersAtStart = answers;
  firstRead = new Promise<void>((resolve) => {
    finishFirstRead = resolve;
  });
  const timer = setTimeout(() => {
    finishFirstRead?.();
  }, FIRST_READ_MS);
  const apply = (s: Network.NetworkState | undefined, event: boolean) => {
    if (!live) return;
    // Expo's iOS one-shot read returns NONE when its 5 s timeout expires. Only
    // an event can confirm a late negative. Requests may still reach a LAN server.
    let next = s?.isConnected;
    if (
      next === false &&
      ((s?.type as string) === 'UNKNOWN' ||
        (!event && Platform.OS === 'ios' && performance.now() - started >= IOS_PROBE_TIMEOUT_MS))
    )
      next = undefined;
    if (event) monitorOffline = next === false;
    setOnline(next);
    finishFirstRead?.();
  };
  let sub: { remove: () => void } | undefined;
  try {
    sub = Network.addNetworkStateListener((s) => {
      heard = true;
      apply(s, true);
    });
    Promise.resolve(Network.getNetworkStateAsync()).then(
      (s) => {
        if (!heard && answers === answersAtStart) apply(s, false);
      },
      () => {
        if (live) finishFirstRead?.();
      },
    );
  } catch {
    finishFirstRead?.();
  }
  return () => {
    live = false;
    clearTimeout(timer);
    finishFirstRead?.();
    finishFirstRead = undefined;
    firstRead = undefined;
    monitorOffline = false;
    online = undefined;
    sub?.remove?.();
  };
}
