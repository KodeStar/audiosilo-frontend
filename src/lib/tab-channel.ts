import { Platform } from 'react-native';

/**
 * A message channel between the tabs of the web player (the tabs of one browser profile on
 * one origin). A tab never hears its own messages. Null off the web: the app is one runtime,
 * and there is nobody to tell.
 *
 * - `BroadcastChannel` where the browser has it. It needs no secure context, so a plain-http
 *   server (TLS off, the home HTTP address) has it too.
 * - Else `storage` events: the message is written to `localStorage` under the channel's key
 *   and removed at once, and every other tab is told of the write. Slower by a few
 *   milliseconds, and the message must be JSON.
 */
export type TabChannel<T> = {
  post: (message: T) => void;
  /** Be told of each message another tab posts; returns the unsubscribe. */
  subscribe: (listener: (message: T) => void) => () => void;
};

type MessageSource = {
  addEventListener: (type: 'message', listener: (e: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', listener: (e: { data: unknown }) => void) => void;
  postMessage: (message: unknown) => void;
};

type StorageChange = { key: string | null; newValue: string | null };

/** What a channel is made from: the browser's globals (a test's stand-ins). */
export type TabChannelEnv = {
  BroadcastChannel?: new (name: string) => MessageSource;
  localStorage?: Pick<Storage, 'setItem' | 'removeItem'>;
  addEventListener?: (type: 'storage', listener: (e: StorageChange) => void) => void;
  removeEventListener?: (type: 'storage', listener: (e: StorageChange) => void) => void;
};

/** The `localStorage` key a channel's messages pass through (the fallback). */
export const tabChannelKey = (name: string) => `audiosilo-tab:${name}`;

/** The channel `name`, shared by every tab that opens it; null off the web, or in a browser
 * with neither `BroadcastChannel` nor a `localStorage` to pass messages through. */
export function tabChannel<T>(
  name: string,
  env: TabChannelEnv = globalThis as TabChannelEnv,
): TabChannel<T> | null {
  if (Platform.OS !== 'web') return null;
  return broadcastChannel<T>(name, env) ?? storageChannel<T>(name, env);
}

function broadcastChannel<T>(name: string, env: TabChannelEnv): TabChannel<T> | null {
  if (typeof env.BroadcastChannel !== 'function') return null;
  let channel: MessageSource;
  try {
    channel = new env.BroadcastChannel(name);
  } catch {
    return null; // an origin that may not open one: the storage events carry it instead
  }
  return {
    post: (message) => {
      try {
        channel.postMessage(message);
      } catch {
        // A message that could not be cloned or a closed channel: nobody is told.
      }
    },
    subscribe: (listener) => {
      const onMessage = (e: { data: unknown }) => listener(e.data as T);
      channel.addEventListener('message', onMessage);
      return () => channel.removeEventListener('message', onMessage);
    },
  };
}

function storageChannel<T>(name: string, env: TabChannelEnv): TabChannel<T> | null {
  let storage: TabChannelEnv['localStorage'];
  try {
    storage = env.localStorage; // a browser that refuses storage throws on the read
  } catch {
    return null;
  }
  if (!storage || typeof env.addEventListener !== 'function') return null;
  const key = tabChannelKey(name);
  let sent = 0;
  return {
    post: (message) => {
      try {
        // `n`: a value that differs from the last write, so the event fires even when a
        // removal was lost. Removed at once: the key is a wire, not a document.
        storage.setItem(key, JSON.stringify({ message, n: `${Date.now()}.${sent++}` }));
        storage.removeItem(key);
      } catch {
        // Storage refuses writes: nobody is told.
      }
    },
    subscribe: (listener) => {
      const onStorage = (e: StorageChange) => {
        if (e.key !== key || !e.newValue) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.newValue);
        } catch {
          return;
        }
        if (parsed && typeof parsed === 'object' && 'message' in parsed) {
          listener((parsed as { message: T }).message);
        }
      };
      env.addEventListener?.('storage', onStorage);
      return () => env.removeEventListener?.('storage', onStorage);
    },
  };
}
