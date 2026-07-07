import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';
import { DEFAULT_VIRTUAL_CHAPTER_INTERVAL } from '@/playback/book-queue';

const KEY = 'audiosilo.settings';

/** When the player may auto-download the next book in a series: never, only on an
 * unmetered (wifi/ethernet) connection, or always. */
export type AutoDownloadMode = 'never' | 'wifi' | 'always';

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
  /** Auto-start the next book in a series when the current one finishes. */
  autoPlayNext: boolean;
  /** Whether/when to prefetch the next book in a series (near the end of the current). */
  autoDownloadNext: AutoDownloadMode;
  /** Delete a downloaded book's local files once it is marked finished. */
  autoDeleteFinished: boolean;
};

const DEFAULTS: PlaybackSettings = {
  skipForward: 30,
  skipBackward: 15,
  defaultRate: 1,
  autoRewindMax: 5,
  virtualChapterInterval: DEFAULT_VIRTUAL_CHAPTER_INTERVAL,
  autoPlayNext: false,
  autoDownloadNext: 'wifi',
  autoDeleteFinished: true,
};

type SettingsState = PlaybackSettings & {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setSkipForward: (seconds: number) => void;
  setSkipBackward: (seconds: number) => void;
  setDefaultRate: (rate: number) => void;
  setAutoRewindMax: (seconds: number) => void;
  setVirtualChapterInterval: (seconds: number) => void;
  setAutoPlayNext: (on: boolean) => void;
  setAutoDownloadNext: (mode: AutoDownloadMode) => void;
  setAutoDeleteFinished: (on: boolean) => void;
};

export const useSettings = create<SettingsState>()((set, get) => {
  const save = () => {
    const {
      skipForward,
      skipBackward,
      defaultRate,
      autoRewindMax,
      virtualChapterInterval,
      autoPlayNext,
      autoDownloadNext,
      autoDeleteFinished,
    } = get();
    void setItem(KEY, {
      skipForward,
      skipBackward,
      defaultRate,
      autoRewindMax,
      virtualChapterInterval,
      autoPlayNext,
      autoDownloadNext,
      autoDeleteFinished,
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
    setAutoPlayNext: (autoPlayNext) => {
      set({ autoPlayNext });
      save();
    },
    setAutoDownloadNext: (autoDownloadNext) => {
      set({ autoDownloadNext });
      save();
    },
    setAutoDeleteFinished: (autoDeleteFinished) => {
      set({ autoDeleteFinished });
      save();
    },
  };
});
