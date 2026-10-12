import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { identityMovePending } from './connection-id';
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
    expect(identityMovePending()).toBe(false);
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

  it('a stored plan that keeps failing stops holding the launch after a few tries', async () => {
    await AsyncStorage.setItem('audiosilo.storageVersion', JSON.stringify(2));
    await AsyncStorage.setItem(
      'audiosilo.connections',
      JSON.stringify([{ id: 'srv', serverUrl: 'https://a', name: 'A', user: { id: 3 } }]),
    );
    await AsyncStorage.setItem('audiosilo.identityPlan', JSON.stringify({ srv: 'srv.3' }));
    const store = SecureStore as unknown as { getItemAsync: (k: string) => Promise<unknown> };
    const original = store.getItemAsync;
    const read = jest.fn(() => Promise.reject(new Error('keychain locked')));
    store.getItemAsync = read;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const run = migrateStorage();
      await jest.advanceTimersByTimeAsync(10_000);
      const result = await run;
      expect(result.identity).toMatchObject({
        status: 'aborted',
        step: 'tokens',
        recoveryRequired: true,
      });
      expect(read).toHaveBeenCalledTimes(5);
      // The plan stays for a later launch to finish, and until then the readers keep what
      // names an id no connection has (never pruned as gone).
      expect(await AsyncStorage.getItem('audiosilo.identityPlan')).not.toBeNull();
      expect(identityMovePending()).toBe(true);
    } finally {
      store.getItemAsync = original;
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});

it('finding 2: holds bootstrap readers until a partial transaction is reconciled', async () => {
  await AsyncStorage.clear();
  forgetStorageMigration();
  await AsyncStorage.setItem('audiosilo.storageVersion', '2');
  await AsyncStorage.setItem(
    'audiosilo.connections',
    JSON.stringify([{ id: 'srv', serverUrl: 'https://a', name: 'A', user: { id: 3 } }]),
  );
  await AsyncStorage.setItem('audiosilo.progressQueue', JSON.stringify([{ connectionId: 'srv' }]));
  await SecureStore.setItemAsync('audiosilo.token.srv', 'tok');
  const store = AsyncStorage.setMany as jest.Mock;
  const original = store.getMockImplementation()!;
  store.mockImplementationOnce(async (entries: Record<string, string>) => {
    await AsyncStorage.setItem('audiosilo.progressQueue', entries['audiosilo.progressQueue']);
    throw new Error('disk full');
  });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.useFakeTimers();
  try {
    let ready = false;
    const run = migrateStorage().then(() => {
      ready = true;
    });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(ready).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    await run;
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.connections'))!)[0].id).toBe('srv.3');
    expect(
      JSON.parse((await AsyncStorage.getItem('audiosilo.progressQueue'))!)[0].connectionId,
    ).toBe('srv.3');
  } finally {
    store.mockImplementation(original);
    warn.mockRestore();
    jest.useRealTimers();
  }
});
