import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';

// A keychain-like fake: items are keyed by service + key (expo-secure-store's default service is
// "app"), each remembering the accessibility it was written with. As in the real module, a set
// over an existing item updates the DATA only and keeps its accessibility.
type Item = { value: string; accessible: number | undefined };
const keychain = new Map<string, Item>();
const id = (key: string, opts?: SecureStore.SecureStoreOptions) =>
  `${opts?.keychainService ?? 'app'}|${key}`;

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK: 0,
  WHEN_UNLOCKED: 5,
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const get = jest.mocked(SecureStore.getItemAsync);
const set = jest.mocked(SecureStore.setItemAsync);
const del = jest.mocked(SecureStore.deleteItemAsync);

function installFake() {
  get.mockImplementation(async (key, opts) => keychain.get(id(key, opts))?.value ?? null);
  set.mockImplementation(async (key, value, opts) => {
    const existing = keychain.get(id(key, opts));
    keychain.set(id(key, opts), {
      value,
      accessible: existing ? existing.accessible : opts?.keychainAccessible,
    });
  });
  del.mockImplementation(async (key, opts) => {
    keychain.delete(id(key, opts));
  });
}

// secure-store.ts branches on Platform.OS at call time, so we flip it per suite.
function setPlatform(os: string) {
  (Platform as { OS: string }).OS = os;
}

const NEW = 'audiosilo.tokens.afu';
const AFTER_FIRST_UNLOCK = 0;
const WHEN_UNLOCKED = 5;

describe('secure-store (iOS)', () => {
  beforeEach(() => {
    setPlatform('ios');
    jest.clearAllMocks();
    keychain.clear();
    installFake();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('writes new tokens readable after first unlock, and round-trips', async () => {
    await setSecure('k', 'v');
    expect(keychain.get(`${NEW}|k`)).toEqual({ value: 'v', accessible: AFTER_FIRST_UNLOCK });
    await expect(getSecure('k')).resolves.toBe('v');
    await deleteSecure('k');
    await expect(getSecure('k')).resolves.toBeNull();
  });

  it('moves an old WHEN_UNLOCKED token on its first read: copy, verify, then drop the old', async () => {
    keychain.set('app|k', { value: 'tok', accessible: WHEN_UNLOCKED });
    await expect(getSecure('k')).resolves.toBe('tok');
    expect(keychain.get(`${NEW}|k`)).toEqual({ value: 'tok', accessible: AFTER_FIRST_UNLOCK });
    expect(keychain.has('app|k')).toBe(false);
    // The old item was deleted only after the copy was written and read back.
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]).toEqual(['k']);
    expect(del.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...set.mock.invocationCallOrder, ...get.mock.invocationCallOrder),
    );
  });

  it('a failed write keeps the old token, returns it, and retries next launch', async () => {
    keychain.set('app|k', { value: 'tok', accessible: WHEN_UNLOCKED });
    set.mockRejectedValueOnce(new Error('errSecInteractionNotAllowed'));
    await expect(getSecure('k')).resolves.toBe('tok');
    expect(keychain.get('app|k')).toEqual({ value: 'tok', accessible: WHEN_UNLOCKED });
    expect(keychain.has(`${NEW}|k`)).toBe(false);

    // Next launch: the move succeeds.
    await expect(getSecure('k')).resolves.toBe('tok');
    expect(keychain.get(`${NEW}|k`)?.accessible).toBe(AFTER_FIRST_UNLOCK);
    expect(keychain.has('app|k')).toBe(false);
  });

  it('a copy that does not read back is removed and the old token kept', async () => {
    keychain.set('app|k', { value: 'tok', accessible: WHEN_UNLOCKED });
    set.mockImplementationOnce(async (key, _value, opts) => {
      keychain.set(id(key, opts), { value: 'garbled', accessible: AFTER_FIRST_UNLOCK });
    });
    await expect(getSecure('k')).resolves.toBe('tok');
    expect(keychain.has(`${NEW}|k`)).toBe(false);
    expect(keychain.get('app|k')?.value).toBe('tok');
  });

  it('an already-moved token is a no-op (one read, no writes or deletes)', async () => {
    keychain.set(`${NEW}|k`, { value: 'tok', accessible: AFTER_FIRST_UNLOCK });
    await expect(getSecure('k')).resolves.toBe('tok');
    expect(get).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('a missing token stays missing (nothing written)', async () => {
    await expect(getSecure('k')).resolves.toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it('prefers the moved token over a leftover old copy', async () => {
    keychain.set('app|k', { value: 'old', accessible: WHEN_UNLOCKED });
    keychain.set(`${NEW}|k`, { value: 'new', accessible: AFTER_FIRST_UNLOCK });
    await expect(getSecure('k')).resolves.toBe('new');
  });

  it('deletes both homes', async () => {
    keychain.set('app|k', { value: 'old', accessible: WHEN_UNLOCKED });
    keychain.set(`${NEW}|k`, { value: 'new', accessible: AFTER_FIRST_UNLOCK });
    await deleteSecure('k');
    expect(keychain.size).toBe(0);
  });
});

describe('secure-store (Android)', () => {
  beforeEach(() => {
    setPlatform('android');
    jest.clearAllMocks();
    keychain.clear();
    installFake();
  });

  afterEach(() => setPlatform('ios'));

  it('keeps the module defaults (no service or accessibility options)', async () => {
    await setSecure('k', 'v');
    expect(set).toHaveBeenCalledWith('k', 'v');
    await expect(getSecure('k')).resolves.toBe('v');
    expect(get).toHaveBeenCalledWith('k');
    await deleteSecure('k');
    expect(del).toHaveBeenCalledWith('k');
    await expect(getSecure('k')).resolves.toBeNull();
  });
});

describe('secure-store (web)', () => {
  const mem = new Map<string, string>();

  beforeEach(() => {
    setPlatform('web');
    jest.clearAllMocks();
    mem.clear();
    globalThis.localStorage = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  });

  afterEach(() => setPlatform('ios'));

  it('uses localStorage and never touches expo-secure-store', async () => {
    await setSecure('k', 'v');
    expect(mem.get('k')).toBe('v');
    await expect(getSecure('k')).resolves.toBe('v');
    await deleteSecure('k');
    await expect(getSecure('k')).resolves.toBeNull();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
