import type { TabChannelEnv } from '@/lib/tab-channel';

type MessageListener = (e: { data: unknown }) => void;
type StorageListener = (e: { key: string | null; newValue: string | null }) => void;

/** One tab's globals in a `fakeBrowser`: what `tabChannel` takes as its `env`. */
export type FakeTab = Required<Pick<TabChannelEnv, 'addEventListener' | 'removeEventListener'>> &
  Pick<TabChannelEnv, 'BroadcastChannel'> & {
    localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  };

/**
 * A browser for tests of what the web player's tabs tell each other: every `tab()` shares
 * one `localStorage` (a write tells every OTHER tab with a `storage` event) and one set of
 * `BroadcastChannel`s (a message reaches every other instance of its name, never the one
 * that posted it). Events are delivered in a microtask, as a browser delivers them in a
 * later task: never inside the call that caused them (`delay`: that many ms later instead,
 * the time a real event takes to cross to another tab). `broadcast: false` is a browser
 * without `BroadcastChannel`.
 */
export function fakeBrowser({
  broadcast = true,
  delay,
}: { broadcast?: boolean; delay?: number } = {}) {
  const data = new Map<string, string>();
  const tabs = new Set<Set<StorageListener>>();
  const channels = new Map<string, Set<Set<MessageListener>>>();
  const later = (fn: () => void) =>
    void (delay === undefined ? Promise.resolve().then(fn) : setTimeout(fn, delay));

  function tab(): FakeTab {
    const storageListeners = new Set<StorageListener>();
    tabs.add(storageListeners);
    const tell = (key: string, newValue: string | null) => {
      for (const other of tabs) {
        if (other === storageListeners) continue;
        for (const listener of [...other]) later(() => listener({ key, newValue }));
      }
    };
    class Channel {
      private readonly listeners = new Set<MessageListener>();
      constructor(private readonly name: string) {
        const all = channels.get(name) ?? new Set();
        all.add(this.listeners);
        channels.set(name, all);
      }
      postMessage(message: unknown) {
        // Structured clone, as the browser does: the receiver never shares the object.
        const data = structuredClone(message);
        for (const other of channels.get(this.name) ?? []) {
          if (other === this.listeners) continue;
          for (const listener of [...other]) later(() => listener({ data }));
        }
      }
      addEventListener(_type: 'message', listener: MessageListener) {
        this.listeners.add(listener);
      }
      removeEventListener(_type: 'message', listener: MessageListener) {
        this.listeners.delete(listener);
      }
    }
    return {
      ...(broadcast ? { BroadcastChannel: Channel } : {}),
      localStorage: {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
          data.set(key, value);
          tell(key, value);
        },
        removeItem: (key) => {
          if (!data.delete(key)) return;
          tell(key, null);
        },
      },
      addEventListener: (_type, listener) => void storageListeners.add(listener),
      removeEventListener: (_type, listener) => void storageListeners.delete(listener),
    };
  }

  return { tab, data };
}

/**
 * `@/lib/storage` for one tab of a `fakeBrowser`: the web keeps its documents in
 * `localStorage`, as JSON under the keys as they are. For a test whose tabs are separate
 * copies of the modules (`jest.isolateModules`): mock `@/lib/storage` with this over the
 * tab being loaded. Not the AsyncStorage package: Babel requires that one lazily, so every
 * copy would share the first tab's.
 */
export function tabStorage(storage: FakeTab['localStorage']) {
  const read = (key: string): unknown => {
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return {
    getItem: async (key: string) => read(key),
    getItemStrict: async (key: string) => read(key),
    setItem: async (key: string, value: unknown) => storage.setItem(key, JSON.stringify(value)),
    setItemStrict: async (key: string, value: unknown) =>
      storage.setItem(key, JSON.stringify(value)),
    removeItem: async (key: string) => storage.removeItem(key),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `done()`, on real timers (the tabs talk in later turns, the outbox through
 * its locks). */
export async function until(done: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 1000; i++) {
    if (await done()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}
