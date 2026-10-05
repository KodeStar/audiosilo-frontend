import AsyncStorage from '@react-native-async-storage/async-storage';

import { forgetStorageMigration, migrateStorage } from './storage-migration';

describe('migrateStorage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    forgetStorageMigration();
  });

  it('writes system for a new install, then records the storage versions', async () => {
    const result = await migrateStorage();
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('system'));
    expect(result).toEqual({ authReset: true, cacheReset: false });
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

  it('runs once: every caller shares the same run', async () => {
    const a = migrateStorage();
    const b = migrateStorage();
    expect(a).toBe(b);
    await a;
  });
});
