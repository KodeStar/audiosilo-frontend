import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';

const KEY = 'audiosilo.settings';

export type PlaybackSettings = {
  /** Skip-forward jump in seconds. */
  skipForward: number;
  /** Skip-backward jump in seconds. */
  skipBackward: number;
  /** Default playback speed for a book with no saved speed. */
  defaultRate: number;
};

const DEFAULTS: PlaybackSettings = { skipForward: 30, skipBackward: 15, defaultRate: 1 };

type SettingsState = PlaybackSettings & {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setSkipForward: (seconds: number) => void;
  setSkipBackward: (seconds: number) => void;
  setDefaultRate: (rate: number) => void;
};

export const useSettings = create<SettingsState>()((set, get) => {
  const save = () => {
    const { skipForward, skipBackward, defaultRate } = get();
    void setItem(KEY, { skipForward, skipBackward, defaultRate });
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
  };
});
