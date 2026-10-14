import { activeProfile, type KidsSettings, useProfiles } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';

import type { AutoSleepConfig } from './auto-sleep';

/** Kids mode's bedtime ends here, local time: from the profile's bedtime until this, a
 * story that starts or resumes gets a sleep timer (Phase 8). */
export const KIDS_BEDTIME_UNTIL = '06:00';

/** How long a story plays at bedtime before the timer fades it out (a duration timer, so
 * it fades like any other). */
const KIDS_BEDTIME_MINUTES = 20;

/** The playback settings of the person listening (`listenerSettings`). */
export type ListenerSettings = {
  /** The speed a book with no speed of its own starts at. */
  defaultRate: number;
  /** The auto sleep rule that applies now (`decideAutoSleep` applies it). */
  autoSleep: AutoSleepConfig;
};

type SettingsInput = Pick<
  ReturnType<typeof useSettings.getState>,
  'defaultRate' | 'autoSleepTimer' | 'autoSleepFrom' | 'autoSleepUntil' | 'autoSleepType'
>;

/** The default speed for a listener in kids mode or not: 1x for a kids profile (the
 * default speed is a device-wide grown-up's setting and kids mode has no speed control, so
 * a child never inherits a grown-up's 1.4x; 8b-1, D3), else the setting. */
const defaultRateFor = (kids: boolean, rate: number) => (kids ? 1 : rate);

/**
 * The device's playback settings as they apply to whoever listens (pure). A kids
 * profile: 1x as the default speed (a story with a speed saved for the kid keeps it,
 * `bookSpeed`), and its bedtime rule, always on, from its bedtime until
 * `KIDS_BEDTIME_UNTIL`, a `KIDS_BEDTIME_MINUTES` timer on every story that starts or
 * resumes; it REPLACES the device-wide auto sleep setting (a grown-up's "end of chapter
 * from 22:00" is not a child's bedtime). Everyone else: the settings, untouched.
 */
export function listenerSettingsFor(
  kids: Pick<KidsSettings, 'bedtime'> | undefined,
  s: SettingsInput,
): ListenerSettings {
  return {
    defaultRate: defaultRateFor(!!kids, s.defaultRate),
    autoSleep: kids
      ? { enabled: true, from: kids.bedtime, until: KIDS_BEDTIME_UNTIL, type: KIDS_BEDTIME_MINUTES }
      : {
          enabled: s.autoSleepTimer,
          from: s.autoSleepFrom,
          until: s.autoSleepUntil,
          type: s.autoSleepType,
        },
  };
}

/** `listenerSettingsFor` the person listening now. Read at each start (`playBook`), by the
 * car's native start specs and by the auto sleep controller. */
export function listenerSettings(): ListenerSettings {
  return listenerSettingsFor(activeProfile()?.kids, useSettings.getState());
}

/** The person listening's default speed (`listenerSettings`), for a screen: it follows
 * the setting and a switch of person. */
export function useListenerDefaultRate(): number {
  const kids = useProfiles((s) => !!activeProfile(s)?.kids);
  const rate = useSettings((s) => s.defaultRate);
  return defaultRateFor(kids, rate);
}
