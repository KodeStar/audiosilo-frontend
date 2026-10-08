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
        keepAhead: 0,
        autoDeleteFinished: true,
        autoSleepTimer: false,
        autoSleepFrom: '22:00',
        autoSleepUntil: '06:00',
        autoSleepType: 'chapter',
        shakeToExtend: true,
        shakeSensitivity: 'medium',
        smartSpeed: false,
        voiceBoost: false,
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

  it('keeps the next books ready only at a valid choice, off by default', async () => {
    expect(useSettings.getState().keepAhead).toBe(0);
    await AsyncStorage.setItem(KEY, JSON.stringify({ keepAhead: 7 }));
    await useSettings.getState().hydrate();
    expect(useSettings.getState().keepAhead).toBe(0);
    useSettings.getState().setKeepAhead(2);
    await restart();
    expect(useSettings.getState().keepAhead).toBe(2);
  });

  it('shakes to extend at medium sensitivity for a blob saved before the settings existed', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ skipForward: 45 }));
    await useSettings.getState().hydrate();
    expect(useSettings.getState().shakeToExtend).toBe(true);
    expect(useSettings.getState().shakeSensitivity).toBe('medium');
  });

  it('reads a corrupt stored shake setting as the default', async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ shakeToExtend: 'yes', shakeSensitivity: 'extreme' }),
    );
    await useSettings.getState().hydrate();
    // Only an explicit false switches the feature off.
    expect(useSettings.getState().shakeToExtend).toBe(true);
    expect(useSettings.getState().shakeSensitivity).toBe('medium');
  });

  it('persists and round-trips the shake settings', async () => {
    await useSettings.getState().hydrate();
    useSettings.getState().setShakeToExtend(false);
    useSettings.getState().setShakeSensitivity('high');
    await restart();
    expect(useSettings.getState().shakeToExtend).toBe(false);
    expect(useSettings.getState().shakeSensitivity).toBe('high');
  });

  it('keeps Smart Speed and Voice Boost off for a blob saved before they existed, or a corrupt one', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ skipForward: 45 }));
    await useSettings.getState().hydrate();
    expect(useSettings.getState().smartSpeed).toBe(false);
    expect(useSettings.getState().voiceBoost).toBe(false);

    load();
    await AsyncStorage.setItem(KEY, JSON.stringify({ smartSpeed: 'yes', voiceBoost: 1 }));
    await useSettings.getState().hydrate();
    expect(useSettings.getState().smartSpeed).toBe(false);
    expect(useSettings.getState().voiceBoost).toBe(false);
  });

  it('persists and round-trips Smart Speed and Voice Boost', async () => {
    await useSettings.getState().hydrate();
    useSettings.getState().setSmartSpeed(true);
    useSettings.getState().setVoiceBoost(true);
    await restart();
    expect(useSettings.getState().smartSpeed).toBe(true);
    expect(useSettings.getState().voiceBoost).toBe(true);
  });
});
