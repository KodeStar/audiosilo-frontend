import { create } from 'zustand';

import { persistedDocument } from '@/lib/storage';
import { DEFAULT_VIRTUAL_CHAPTER_INTERVAL } from '@/playback/book-queue';

/** When the player may auto-download a book to the device: never, only on an
 * unmetered (wifi/ethernet) connection, or always. */
export type AutoDownloadMode = 'never' | 'wifi' | 'always';

/** How many books after the current one to keep downloaded ("Keep the next books
 * ready"): 0 is off. Rules and the planner live in `src/downloads/keep-ahead.ts`. */
export type KeepAhead = 0 | 1 | 2 | 3;
export const KEEP_AHEAD_CHOICES: readonly KeepAhead[] = [0, 1, 2, 3];

/** A stored value read back as a valid choice: anything that isn't one is off. */
export function toKeepAhead(value: unknown): KeepAhead {
  return KEEP_AHEAD_CHOICES.includes(value as KeepAhead) ? (value as KeepAhead) : 0;
}

/** What an auto-armed sleep timer does: stop at the end of the current chapter, or
 * after a fixed number of minutes. The numeric members are minutes; a string union
 * keeps the value trivially persistable and every `switch` over it exhaustive. */
export type AutoSleepType = 'chapter' | '15' | '30' | '45' | '60';

/** How hard a shake has to be to keep a sleep timer going (`use-shake-to-extend.ts` maps
 * each to its detector tuning). `medium` is the tuning the detector always had. */
export type ShakeSensitivity = 'low' | 'medium' | 'high';
export const SHAKE_SENSITIVITIES: readonly ShakeSensitivity[] = ['low', 'medium', 'high'];

/** A stored value read back as a valid choice: anything that isn't one is `medium`. */
export function toShakeSensitivity(value: unknown): ShakeSensitivity {
  return SHAKE_SENSITIVITIES.includes(value as ShakeSensitivity)
    ? (value as ShakeSensitivity)
    : 'medium';
}

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
  /** Keep this many of the next books (Up next, then the series) downloaded while a book
   * is loaded, under the `autoDownloadNext` network rule. Off by default: it downloads on
   * its own, so the listener opts in. */
  keepAhead: KeepAhead;
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
  /** A shake in a sleep timer's last seconds (or just after it paused) keeps listening.
   * Native only: the web has no accelerometer. */
  shakeToExtend: boolean;
  /** How hard that shake has to be. */
  shakeSensitivity: ShakeSensitivity;
  /** Smart Speed: trim the silences between words (Android only: withdrawn on iOS, never
   * the web; kept on iOS so a shared value isn't lost). Device-wide, not per book. */
  smartSpeed: boolean;
  /** Voice Boost: compress and lift speech (native, and the web outside Safari).
   * Device-wide, not per book. */
  voiceBoost: boolean;
};

const DEFAULTS: PlaybackSettings = {
  skipForward: 30,
  skipBackward: 15,
  defaultRate: 1,
  autoRewindMax: 5,
  virtualChapterInterval: DEFAULT_VIRTUAL_CHAPTER_INTERVAL,
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
};

// A stored blob may predate a setting (DEFAULTS fill it) or not be an object at all.
const stored = persistedDocument<PlaybackSettings>('audiosilo.settings', (raw) =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<PlaybackSettings>) : {},
);

type SettingsState = PlaybackSettings & {
  hydrate: () => Promise<void>;
  setSkipForward: (seconds: number) => void;
  setSkipBackward: (seconds: number) => void;
  setDefaultRate: (rate: number) => void;
  setAutoRewindMax: (seconds: number) => void;
  setVirtualChapterInterval: (seconds: number) => void;
  setAutoPlayNext: (on: boolean) => void;
  setAutoDownloadNext: (mode: AutoDownloadMode) => void;
  setKeepAhead: (count: KeepAhead) => void;
  setAutoDeleteFinished: (on: boolean) => void;
  setAutoSleepTimer: (on: boolean) => void;
  setAutoSleepFrom: (hhmm: string) => void;
  setAutoSleepUntil: (hhmm: string) => void;
  setAutoSleepType: (type: AutoSleepType) => void;
  setShakeToExtend: (on: boolean) => void;
  setShakeSensitivity: (sensitivity: ShakeSensitivity) => void;
  setSmartSpeed: (on: boolean) => void;
  setVoiceBoost: (on: boolean) => void;
};

/** The persisted settings, under the shared hydration rule (`persistedDocument`): a
 * setting changed before hydration finished wins over its stored value, and never
 * clobbers the settings it did not touch. Hydrated once at boot by `bootstrapPlayback`. */
export const useSettings = create<SettingsState>()((set, get) => {
  // Every setter goes through here: set the one value, then persist the WHOLE document -
  // exactly the persisted keys (DEFAULTS' own), never the store's functions.
  const update = (change: Partial<PlaybackSettings>) => {
    set(change);
    const state = get();
    const doc = Object.fromEntries(
      (Object.keys(DEFAULTS) as (keyof PlaybackSettings)[]).map((k) => [k, state[k]]),
    ) as PlaybackSettings;
    stored.write(change, doc);
  };
  return {
    ...DEFAULTS,
    hydrate: () =>
      stored.hydrate(DEFAULTS, (doc) =>
        set({
          ...doc,
          keepAhead: toKeepAhead(doc.keepAhead),
          shakeToExtend: doc.shakeToExtend !== false,
          shakeSensitivity: toShakeSensitivity(doc.shakeSensitivity),
          // Off unless the stored value says on (a document from before they existed has
          // none; anything that isn't `true` is not a listener's choice).
          smartSpeed: doc.smartSpeed === true,
          voiceBoost: doc.voiceBoost === true,
        }),
      ),
    setSkipForward: (skipForward) => update({ skipForward }),
    setSkipBackward: (skipBackward) => update({ skipBackward }),
    setDefaultRate: (defaultRate) => update({ defaultRate }),
    setAutoRewindMax: (autoRewindMax) => update({ autoRewindMax }),
    setVirtualChapterInterval: (virtualChapterInterval) => update({ virtualChapterInterval }),
    setAutoPlayNext: (autoPlayNext) => update({ autoPlayNext }),
    setAutoDownloadNext: (autoDownloadNext) => update({ autoDownloadNext }),
    setKeepAhead: (keepAhead) => update({ keepAhead }),
    setAutoDeleteFinished: (autoDeleteFinished) => update({ autoDeleteFinished }),
    setAutoSleepTimer: (autoSleepTimer) => update({ autoSleepTimer }),
    setAutoSleepFrom: (autoSleepFrom) => update({ autoSleepFrom }),
    setAutoSleepUntil: (autoSleepUntil) => update({ autoSleepUntil }),
    setAutoSleepType: (autoSleepType) => update({ autoSleepType }),
    setShakeToExtend: (shakeToExtend) => update({ shakeToExtend }),
    setShakeSensitivity: (shakeSensitivity) => update({ shakeSensitivity }),
    setSmartSpeed: (smartSpeed) => update({ smartSpeed }),
    setVoiceBoost: (voiceBoost) => update({ voiceBoost }),
  };
});
