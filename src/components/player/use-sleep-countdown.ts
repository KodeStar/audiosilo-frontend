import { useTranslation } from 'react-i18next';

import { formatClock } from '@/lib/format';
import {
  selectSleepExtendable,
  selectSleepPhase,
  type SleepTimerState,
  useSleepTimer,
} from '@/playback/sleep-timer';

/** The sleep timer's countdown as the compact players show it ("12:04"), or null when no
 * timer is counting down (idle, or the post-pause grace window, which is not a countdown
 * to anything the listener can see). */
export function selectSleepCountdown(s: SleepTimerState): string | null {
  if ((s.phase !== 'running' && s.phase !== 'ending') || s.remaining === null) return null;
  return formatClock(s.remaining);
}

/** `selectSleepCountdown` for the timer store; re-renders once a second while it runs. */
export function useSleepCountdown(): string | null {
  return useSleepTimer(selectSleepCountdown);
}

/**
 * What the sleep pill says (STYLEGUIDE section 8: the dock's and the full player's sleep
 * control): `active` while a timer runs (brand-soft); `text`, its countdown, or "Keep
 * going" once it has paused playback (null while idle: the caller shows the moon alone,
 * or a word where it has room); `label`, what a press can DO for a screen reader - "Keep
 * listening" in the windows where it keeps the book going (the same selector gates the
 * shake listener, so the spoken promise and the gesture are true together), else the
 * running timer and its time left, else "Sleep timer".
 */
export function useSleepPill(): { active: boolean; text: string | null; label: string } {
  const { t } = useTranslation();
  const phase = useSleepTimer(selectSleepPhase);
  const remaining = useSleepTimer((s) => s.remaining);
  const timer = useSleepTimer((s) => s.label);
  const extendable = useSleepTimer(selectSleepExtendable);
  const active = phase !== 'idle';
  const text =
    phase === 'grace'
      ? t('player.sleepTimer.keepGoingShort')
      : active && remaining !== null
        ? formatClock(remaining)
        : null;
  const label = extendable
    ? t('player.sleepTimer.keepListening')
    : active && timer && remaining !== null
      ? t('player.sleepTimer.pillRunning', {
          label: t(timer.key, timer.params),
          time: formatClock(remaining),
        })
      : t('player.sleepTimer.title');
  return { active, text, label };
}
