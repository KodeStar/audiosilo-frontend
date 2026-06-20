import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';

// secure-store.ts branches on Platform.OS at call time, so we flip it per suite.
function setPlatform(os: string) {
  (Platform as { OS: string }).OS = os;
}

describe('secure-store (native)', () => {
  beforeEach(() => {
    setPlatform('ios');
    jest.clearAllMocks();
  });

  it('delegates to expo-secure-store and round-trips', async () => {
    await setSecure('k', 'v');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('k', 'v');
    await expect(getSecure('k')).resolves.toBe('v');
    await deleteSecure('k');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('k');
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
