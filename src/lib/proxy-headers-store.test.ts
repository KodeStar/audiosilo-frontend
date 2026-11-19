import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import {
  copyProxyHeaders,
  forgetProxyHeaders,
  forgetProxySets,
  PROXY_SETS_KEY,
  PROXY_SETS_MARKER_KEY,
  proxyHeadersKey,
  readLegacyProxyHeaders,
  readProxySets,
  saveProxySets,
} from './proxy-headers-store';

const ORIGIN = 'https://books.example.com';
const SET = {
  origin: ORIGIN,
  headers: [{ name: 'CF-Access-Client-Secret', value: 'proxy-secret' }],
};
const OTHER = {
  origin: 'https://other.example.net',
  headers: [{ name: 'X-Auth', value: 'two' }],
};

type Store = {
  getItemAsync: (k: string, o?: unknown) => Promise<string | null>;
  setItemAsync: (k: string, v: string, o?: unknown) => Promise<void>;
};
const store = SecureStore as unknown as Store;

const stored = async () => JSON.parse((await SecureStore.getItemAsync(PROXY_SETS_KEY)) ?? 'null');

describe('proxy headers storage: one set per origin (fe#295)', () => {
  beforeEach(async () => {
    await forgetProxySets();
    await Promise.all(['a', 'b'].map((id) => forgetProxyHeaders(id)));
  });

  it('keeps each origin its own set, in one item marked as there, and removes one by origin', async () => {
    expect(await readProxySets()).toEqual({});
    await saveProxySets({ [ORIGIN]: SET });
    await saveProxySets({ [OTHER.origin]: OTHER });
    expect(await readProxySets()).toEqual({ [ORIGIN]: SET, [OTHER.origin]: OTHER });
    expect(await AsyncStorage.getItem(PROXY_SETS_MARKER_KEY)).toBe('true');

    await saveProxySets({ [ORIGIN]: null });
    expect(await readProxySets()).toEqual({ [OTHER.origin]: OTHER });
    // The last one gone: the item and its marker go too.
    await saveProxySets({ [OTHER.origin]: { ...OTHER, headers: [] } });
    expect(await SecureStore.getItemAsync(PROXY_SETS_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(PROXY_SETS_MARKER_KEY)).toBeNull();
  });

  it('reads no keychain item without the marker', async () => {
    await SecureStore.setItemAsync(PROXY_SETS_KEY, JSON.stringify({ [ORIGIN]: SET }));
    const read = SecureStore.getItemAsync as jest.Mock;
    read.mockClear();
    expect(await readProxySets()).toEqual({});
    expect(read.mock.calls.some(([k]) => k === PROXY_SETS_KEY)).toBe(false);
  });

  it('clears a marker with no item behind it, so the next launch reads nothing', async () => {
    await AsyncStorage.setItem(PROXY_SETS_MARKER_KEY, 'true');
    expect(await readProxySets()).toEqual({});
    expect(await AsyncStorage.getItem(PROXY_SETS_MARKER_KEY)).toBeNull();
  });

  it('keeps the marker of a save under way, its item not written yet', async () => {
    const original = store.setItemAsync;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    store.setItemAsync = async (k, v, o) => {
      if (k === PROXY_SETS_KEY) await held;
      return original(k, v, o);
    };
    try {
      const saving = saveProxySets({ [ORIGIN]: SET });
      while ((await AsyncStorage.getItem(PROXY_SETS_MARKER_KEY)) !== 'true') {
        await new Promise((r) => setTimeout(r, 0));
      }
      // A read between the marker and the item (another tab's, a hydrate) finds no item
      // and clears nothing.
      const reading = readProxySets();
      await new Promise((r) => setTimeout(r, 10));
      release();
      await saving;
      expect(await reading).toEqual({});
    } finally {
      store.setItemAsync = original;
    }
    expect(await AsyncStorage.getItem(PROXY_SETS_MARKER_KEY)).toBe('true');
    expect(await readProxySets()).toEqual({ [ORIGIN]: SET });
  });

  // Hydrate never deletes what this build can't read: another build may (a rollback, a later
  // build with stricter rules).
  it('skips an entry it cannot read, and keeps it through a write of another origin', async () => {
    const foreign = { headers: [{ name: 'Authorization', value: 'x' }], future: 1 };
    await saveProxySets({ [ORIGIN]: SET });
    await SecureStore.setItemAsync(
      PROXY_SETS_KEY,
      JSON.stringify({ ...(await stored()), 'https://later.example.org': foreign }),
    );
    expect(await readProxySets()).toEqual({ [ORIGIN]: SET });
    await saveProxySets({ [OTHER.origin]: OTHER });
    expect(await stored()).toEqual({
      [ORIGIN]: { headers: SET.headers },
      'https://later.example.org': foreign,
      [OTHER.origin]: { headers: OTHER.headers },
    });
  });

  it('reads a damaged item as none and leaves it, until a set is saved over it', async () => {
    await AsyncStorage.setItem(PROXY_SETS_MARKER_KEY, 'true');
    await SecureStore.setItemAsync(PROXY_SETS_KEY, '{not json');
    expect(await readProxySets()).toEqual({});
    expect(await SecureStore.getItemAsync(PROXY_SETS_KEY)).toBe('{not json');
    await saveProxySets({ [ORIGIN]: SET });
    expect(await readProxySets()).toEqual({ [ORIGIN]: SET });
  });

  it('drops the headers that are not valid, and a set for a plain-http origin', async () => {
    await AsyncStorage.setItem(PROXY_SETS_MARKER_KEY, 'true');
    await SecureStore.setItemAsync(
      PROXY_SETS_KEY,
      JSON.stringify({
        [ORIGIN]: {
          headers: [
            { name: 'Authorization', value: 'x' },
            ...SET.headers,
            { name: 'X', value: 'a\nb' },
          ],
        },
        'http://192.168.1.20:8080': { headers: SET.headers },
      }),
    );
    expect(await readProxySets()).toEqual({ [ORIGIN]: SET });
  });

  it('rejects when the platform refuses the read (the hydrate fails on it)', async () => {
    await saveProxySets({ [ORIGIN]: SET });
    const original = store.getItemAsync;
    store.getItemAsync = () => Promise.reject(new Error('keychain locked'));
    try {
      await expect(readProxySets()).rejects.toThrow('keychain locked');
      // A write reads first: nothing is written over a set it could not read.
      await expect(saveProxySets({ [OTHER.origin]: OTHER })).rejects.toThrow('keychain locked');
    } finally {
      store.getItemAsync = original;
    }
    expect(await readProxySets()).toEqual({ [ORIGIN]: SET });
  });
});

describe('an earlier build’s per-connection sets', () => {
  beforeEach(async () => {
    await Promise.all(['a', 'b'].map((id) => forgetProxyHeaders(id)));
  });

  it('reads a set, an item it cannot read, and none apart', async () => {
    expect(await readLegacyProxyHeaders('a')).toBeNull();
    await SecureStore.setItemAsync(proxyHeadersKey('a'), JSON.stringify(SET));
    expect(await readLegacyProxyHeaders('a')).toEqual(SET);
    await SecureStore.setItemAsync(proxyHeadersKey('a'), '{not json');
    expect(await readLegacyProxyHeaders('a')).toBe('unreadable');
    await SecureStore.setItemAsync(
      proxyHeadersKey('a'),
      JSON.stringify({ origin: 'http://nas:8080', headers: SET.headers }),
    );
    expect(await readLegacyProxyHeaders('a')).toBe('unreadable');
  });

  it('copies an item to a new id byte for byte, writing over a stale copy, and leaves the old key', async () => {
    await SecureStore.setItemAsync(proxyHeadersKey('a'), JSON.stringify(SET));
    await copyProxyHeaders('a', 'b');
    expect(await readLegacyProxyHeaders('b')).toEqual(SET);
    expect(await readLegacyProxyHeaders('a')).toEqual(SET); // the clean-up deletes it, later

    // One this build can't read moves as it is (never dropped on the way).
    await SecureStore.setItemAsync(proxyHeadersKey('a'), '{"v":2}');
    await copyProxyHeaders('a', 'b');
    expect(await SecureStore.getItemAsync(proxyHeadersKey('b'))).toBe('{"v":2}');

    // Removed since: the stale copy goes too, so it never comes back with the connection.
    await forgetProxyHeaders('a');
    await copyProxyHeaders('a', 'b');
    expect(await readLegacyProxyHeaders('b')).toBeNull();
  });

  it('rejects when the copy does not read back, the old entry untouched', async () => {
    const original = store.setItemAsync;
    await SecureStore.setItemAsync(proxyHeadersKey('a'), JSON.stringify(SET));
    store.setItemAsync = (k, v, o) =>
      k === proxyHeadersKey('b') ? Promise.resolve() : original(k, v, o);
    try {
      await expect(copyProxyHeaders('a', 'b')).rejects.toThrow('did not read back');
    } finally {
      store.setItemAsync = original;
    }
    expect(await readLegacyProxyHeaders('a')).toEqual(SET);
    expect(await readLegacyProxyHeaders('b')).toBeNull();
  });
});
