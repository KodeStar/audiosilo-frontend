import AsyncStorage from '@react-native-async-storage/async-storage';

import { useSettings } from '@/stores/settings';

const KEY = 'audiosilo.settings';
const DEFAULTS = {
  skipForward: 30,
  skipBackward: 15,
  defaultRate: 1,
  autoRewindMax: 5,
  virtualChapterInterval: 30 * 60,
  autoPlayNext: false,
  autoDownloadNext: 'wifi' as const,
  autoDeleteFinished: true,
};

const resetStore = () => useSettings.setState({ ...DEFAULTS, hydrated: false });

// Exercises the real settings store over the in-memory AsyncStorage mock (jest.setup).
describe('settings store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetStore();
    jest.clearAllMocks();
  });

  it('exposes the defaults before hydrate', () => {
    const s = useSettings.getState();
    expect(s.skipForward).toBe(30);
    expect(s.skipBackward).toBe(15);
    expect(s.defaultRate).toBe(1);
    expect(s.autoRewindMax).toBe(5);
    expect(s.autoPlayNext).toBe(false);
    expect(s.autoDownloadNext).toBe('wifi');
    expect(s.autoDeleteFinished).toBe(true);
    expect(s.hydrated).toBe(false);
  });

  it('fills missing keys from DEFAULTS for a partial persisted blob', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ skipForward: 45, defaultRate: 1.5 }));
    await useSettings.getState().hydrate();
    const s = useSettings.getState();
    expect(s.skipForward).toBe(45); // from saved
    expect(s.defaultRate).toBe(1.5); // from saved
    expect(s.skipBackward).toBe(15); // filled from DEFAULTS
    expect(s.autoRewindMax).toBe(5); // filled from DEFAULTS
    expect(s.hydrated).toBe(true);
  });

  it('stays at DEFAULTS (hydrated) when nothing is persisted', async () => {
    await useSettings.getState().hydrate();
    const s = useSettings.getState();
    expect(s.skipForward).toBe(30);
    expect(s.skipBackward).toBe(15);
    expect(s.defaultRate).toBe(1);
    expect(s.autoRewindMax).toBe(5);
    expect(s.hydrated).toBe(true);
  });

  it('persists the full merged settings object when a setter runs', async () => {
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
      }),
    );

    // And the persisted value round-trips through hydrate.
    resetStore();
    await useSettings.getState().hydrate();
    expect(useSettings.getState().skipForward).toBe(60);
  });

  it('persists and round-trips the end-of-book settings', async () => {
    useSettings.getState().setAutoPlayNext(true);
    useSettings.getState().setAutoDownloadNext('always');
    useSettings.getState().setAutoDeleteFinished(false);

    const s = useSettings.getState();
    expect(s.autoPlayNext).toBe(true);
    expect(s.autoDownloadNext).toBe('always');
    expect(s.autoDeleteFinished).toBe(false);

    resetStore();
    await useSettings.getState().hydrate();
    const h = useSettings.getState();
    expect(h.autoPlayNext).toBe(true);
    expect(h.autoDownloadNext).toBe('always');
    expect(h.autoDeleteFinished).toBe(false);
  });
});
