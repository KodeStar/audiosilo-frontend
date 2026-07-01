import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';
import { DEFAULT_VIRTUAL_CHAPTER_INTERVAL } from '@/playback/book-queue';

const KEY = 'audiosilo.settings';

export type PlaybackSettings = {
  /** Skip-forward jump in seconds. */
  skipForward: number;
  /** Skip-backward jump in seconds. */
  skipBackward: number;
  /** Default playback speed for a book with no saved speed. */
  defaultRate: number;
  /** Max seconds to rewind when resuming after a pause (0 = disabled). */
  autoRewindMax: number;
  /** Length (seconds) of the virtual chapters synthesized for a long, chapterless
   * single-file book so chapter navigation works. */
  virtualChapterInterval: number;
};

const DEFAULTS: PlaybackSettings = {
  skipForward: 30,
  skipBackward: 15,
  defaultRate: 1,
  autoRewindMax: 5,
  virtualChapterInterval: DEFAULT_VIRTUAL_CHAPTER_INTERVAL,
};

type SettingsState = PlaybackSettings & {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setSkipForward: (seconds: number) => void;
  setSkipBackward: (seconds: number) => void;
  setDefaultRate: (rate: number) => void;
  setAutoRewindMax: (seconds: number) => void;
  setVirtualChapterInterval: (seconds: number) => void;
};

export const useSettings = create<SettingsState>()((set, get) => {
  const save = () => {
    const { skipForward, skipBackward, defaultRate, autoRewindMax, virtualChapterInterval } = get();
    void setItem(KEY, {
      skipForward,
      skipBackward,
      defaultRate,
      autoRewindMax,
      virtualChapterInterval,
    });
  };
  return {
    ...DEFAULTS,
    hydrated: false,
    hydrate: async () => {
      const saved = await getItem<Partial<PlaybackSettings>>(KEY);
      set({ ...DEFAULTS, ...(saved ?? {}), hydrated: true });
    },
    setSkipForward: (skipForward) => {
      set({ skipForward });
      save();
    },
    setSkipBackward: (skipBackward) => {
      set({ skipBackward });
      save();
    },
    setDefaultRate: (defaultRate) => {
      set({ defaultRate });
      save();
    },
    setAutoRewindMax: (autoRewindMax) => {
      set({ autoRewindMax });
      save();
    },
    setVirtualChapterInterval: (virtualChapterInterval) => {
      set({ virtualChapterInterval });
      save();
    },
  };
});
