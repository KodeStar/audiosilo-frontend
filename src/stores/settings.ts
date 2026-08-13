import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';
import { DEFAULT_VIRTUAL_CHAPTER_INTERVAL } from '@/playback/book-queue';

const KEY = 'audiosilo.settings';

/** When the player may auto-download a book to the device: never, only on an
 * unmetered (wifi/ethernet) connection, or always. */
export type AutoDownloadMode = 'never' | 'wifi' | 'always';

/** What an auto-armed sleep timer does: stop at the end of the current chapter, or
 * after a fixed number of minutes. The numeric members are minutes; a string union
 * keeps the value trivially persistable and every `switch` over it exhaustive. */
export type AutoSleepType = 'chapter' | '15' | '30' | '45' | '60';

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
  /** Whether/when to download a book to the device when you start listening to it (the
   * player then switches to the local copy once the download finishes). The persisted key
   * is still `autoDownloadNext` for hydration compatibility - it originally prefetched the
   * *next* book in a series near the current one's end; do not rename it. */
  autoDownloadNext: AutoDownloadMode;
  /** Delete a downloaded book's local files once it is marked finished. */
  autoDeleteFinished: boolean;
  /** Automatically arm a sleep timer for playback started inside the nightly window. */
  autoSleepTimer: boolean;
  /** Window start, local wall-clock "HH:MM" (24h). Parsed, stepped and window-tested
   * by the pure helpers in `@/lib/hhmm` (this store only persists the string). */
  autoSleepFrom: string;
  /** Window end, local wall-clock "HH:MM" (24h). Wraps past midnight when <= from. */
  autoSleepUntil: string;
  /** What the auto-armed timer does: end of the current chapter, or a fixed duration. */
  autoSleepType: AutoSleepType;
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
  autoSleepTimer: false,
  autoSleepFrom: '22:00',
  autoSleepUntil: '06:00',
  autoSleepType: 'chapter',
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
  setAutoSleepTimer: (on: boolean) => void;
  setAutoSleepFrom: (hhmm: string) => void;
  setAutoSleepUntil: (hhmm: string) => void;
  setAutoSleepType: (type: AutoSleepType) => void;
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
      autoSleepTimer,
      autoSleepFrom,
      autoSleepUntil,
      autoSleepType,
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
      autoSleepTimer,
      autoSleepFrom,
      autoSleepUntil,
      autoSleepType,
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
    setAutoSleepTimer: (autoSleepTimer) => {
      set({ autoSleepTimer });
      save();
    },
    setAutoSleepFrom: (autoSleepFrom) => {
      set({ autoSleepFrom });
      save();
    },
    setAutoSleepUntil: (autoSleepUntil) => {
      set({ autoSleepUntil });
      save();
    },
    setAutoSleepType: (autoSleepType) => {
      set({ autoSleepType });
      save();
    },
  };
});
