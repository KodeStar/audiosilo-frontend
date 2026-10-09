import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { forgetStorageMigration, migrateStorage } from './storage-migration';

describe('migrateStorage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    forgetStorageMigration();
  });

  it('writes system for a new install, then records the storage versions', async () => {
    const result = await migrateStorage();
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('system'));
    expect(result).toEqual({ authReset: true, cacheReset: false, identity: { status: 'skipped' } });
    // A fresh install must not look existing on its next launch.
    forgetStorageMigration();
    await AsyncStorage.removeItem('audiosilo.theme');
    await migrateStorage();
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('system'));
  });

  it('writes dark for an existing install with no pick', async () => {
    await AsyncStorage.setItem(
      'audiosilo.knownServers',
      JSON.stringify([{ serverUrl: 'https://a', name: 'A', serverId: 's1' }]),
    );
    await migrateStorage();
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('dark'));
  });

  it('leaves any stored value alone, known or not', async () => {
    await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('auto'));
    await AsyncStorage.setItem('audiosilo.serverUrl', JSON.stringify('https://a'));
    await migrateStorage();
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('auto'));
  });

  it('moves legacy connection ids after the reset, keeping every login', async () => {
    await AsyncStorage.setItem('audiosilo.storageVersion', JSON.stringify(2));
    await AsyncStorage.setItem('audiosilo.cacheVersion', JSON.stringify(1));
    await AsyncStorage.setItem(
      'audiosilo.connections',
      JSON.stringify([{ id: 'srv', serverUrl: 'https://a', name: 'A', user: { id: 3 } }]),
    );
    await SecureStore.setItemAsync('audiosilo.token.srv', 'tok');
    const result = await migrateStorage();
    expect(result).toEqual({
      authReset: false,
      cacheReset: false,
      identity: { status: 'migrated', moved: { srv: 'srv.3' } },
    });
    expect(await SecureStore.getItemAsync('audiosilo.token.srv.3')).toBe('tok');
  });

  it('a migration that stops is reported, never thrown', async () => {
    await AsyncStorage.setItem('audiosilo.storageVersion', JSON.stringify(2));
    await AsyncStorage.setItem(
      'audiosilo.connections',
      JSON.stringify([{ id: 'srv', serverUrl: 'https://a', name: 'A', user: { id: 3 } }]),
    );
    const store = SecureStore as unknown as { getItemAsync: (k: string) => Promise<unknown> };
    const original = store.getItemAsync;
    store.getItemAsync = () => Promise.reject(new Error('keychain unreadable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await migrateStorage();
      expect(result.identity).toMatchObject({ status: 'aborted', step: 'tokens' });
    } finally {
      store.getItemAsync = original;
      warn.mockRestore();
    }
  });

  it('runs once: every caller shares the same run', async () => {
    const a = migrateStorage();
    const b = migrateStorage();
    expect(a).toBe(b);
    await a;
  });
});
