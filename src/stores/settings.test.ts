import type AsyncStorageType from '@react-native-async-storage/async-storage';

import type { useSettings as UseSettings } from '@/stores/settings';

const KEY = 'audiosilo.settings';

// Exercises the real settings store over the in-memory AsyncStorage mock (jest.setup).
// Whether the store has hydrated is MODULE state (`persistedDocument`), so each test
// gets a fresh module registry - and with it a fresh store and an empty storage mock.
let AsyncStorage: typeof AsyncStorageType;
let useSettings: typeof UseSettings;
function load() {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
  useSettings = (require('@/stores/settings') as typeof import('@/stores/settings')).useSettings;
  /* eslint-enable @typescript-eslint/no-require-imports */
}

// A cold start over what is now in storage: a new store, the same stored blob.
async function restart() {
  const blob = await AsyncStorage.getItem(KEY);
  load();
  if (blob) await AsyncStorage.setItem(KEY, blob);
  await useSettings.getState().hydrate();
}

describe('settings store', () => {
  beforeEach(load);

  it('exposes the defaults before hydrate', () => {
    const s = useSettings.getState();
    expect(s.skipForward).toBe(30);
    expect(s.skipBackward).toBe(15);
    expect(s.defaultRate).toBe(1);
    expect(s.autoRewindMax).toBe(5);
    expect(s.autoPlayNext).toBe(false);
    expect(s.autoDownloadNext).toBe('wifi');
    expect(s.autoDeleteFinished).toBe(true);
  });

  it('fills missing keys from DEFAULTS for a partial persisted blob', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ skipForward: 45, defaultRate: 1.5 }));
    await useSettings.getState().hydrate();
    const s = useSettings.getState();
    expect(s.skipForward).toBe(45); // from saved
    expect(s.defaultRate).toBe(1.5); // from saved
    expect(s.skipBackward).toBe(15); // filled from DEFAULTS
    expect(s.autoRewindMax).toBe(5); // filled from DEFAULTS
  });

  it('stays at DEFAULTS when nothing is persisted', async () => {
    await useSettings.getState().hydrate();
    const s = useSettings.getState();
    expect(s.skipForward).toBe(30);
    expect(s.skipBackward).toBe(15);
    expect(s.defaultRate).toBe(1);
    expect(s.autoRewindMax).toBe(5);
  });

  it('persists the full merged settings object when a setter runs', async () => {
    await useSettings.getState().hydrate();
    useSettings.getState().setSkipForward(60);
    expect(useSettings.getState().skipForward).toBe(60);

    // The setter writes the merged object (all keys), not just the changed one.
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      KEY,
      JSON.stringify({
        skipForward: 60,
        skipBackward: 15,
        defaultRate: 1,
        autoRewindMax: 5,
        virtualChapterInterval: 30 * 60,
        autoPlayNext: false,
        autoDownloadNext: 'wifi',
        autoDeleteFinished: true,
        autoSleepTimer: false,
        autoSleepFrom: '22:00',
        autoSleepUntil: '06:00',
        autoSleepType: 'chapter',
      }),
    );

    // And the persisted value round-trips through hydrate.
    await restart();
    expect(useSettings.getState().skipForward).toBe(60);
  });

  it('keeps a setting changed before hydration finished, and the stored rest', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ skipForward: 45, defaultRate: 1.5 }));
    useSettings.getState().setSkipForward(60);
    // Held back: writing now would persist a document missing the stored defaultRate.
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1); // the seed above only
    await useSettings.getState().hydrate();
    expect(useSettings.getState().skipForward).toBe(60);
    expect(useSettings.getState().defaultRate).toBe(1.5);
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!)).toMatchObject({
      skipForward: 60,
      defaultRate: 1.5,
    });
  });

  it('persists and round-trips the end-of-book settings', async () => {
    await useSettings.getState().hydrate();
    useSettings.getState().setAutoPlayNext(true);
    useSettings.getState().setAutoDownloadNext('always');
    useSettings.getState().setAutoDeleteFinished(false);

    const s = useSettings.getState();
    expect(s.autoPlayNext).toBe(true);
    expect(s.autoDownloadNext).toBe('always');
    expect(s.autoDeleteFinished).toBe(false);

    await restart();
    const h = useSettings.getState();
    expect(h.autoPlayNext).toBe(true);
    expect(h.autoDownloadNext).toBe('always');
    expect(h.autoDeleteFinished).toBe(false);
  });

  it('persists and round-trips the auto-sleep-timer settings', async () => {
    await useSettings.getState().hydrate();
    useSettings.getState().setAutoSleepTimer(true);
    useSettings.getState().setAutoSleepFrom('21:30');
    useSettings.getState().setAutoSleepUntil('05:30');
    useSettings.getState().setAutoSleepType('30');

    await restart();
    const h = useSettings.getState();
    expect(h.autoSleepTimer).toBe(true);
    expect(h.autoSleepFrom).toBe('21:30');
    expect(h.autoSleepUntil).toBe('05:30');
    expect(h.autoSleepType).toBe('30');
  });

  it('merges the auto-sleep defaults into a blob saved before the feature existed', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ skipForward: 45 }));
    await useSettings.getState().hydrate();
    const s = useSettings.getState();
    expect(s.autoSleepTimer).toBe(false);
    expect(s.autoSleepFrom).toBe('22:00');
    expect(s.autoSleepUntil).toBe('06:00');
    expect(s.autoSleepType).toBe('chapter');
  });
});
