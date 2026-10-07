import { formatClock } from '@/lib/format';
import { type SleepTimerState, useSleepTimer } from '@/playback/sleep-timer';

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
