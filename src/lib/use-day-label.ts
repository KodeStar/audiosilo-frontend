import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState } from 'react-native';

import { getLocale } from '@/i18n/locale';
import { formatDayDate, formatWeekday } from '@/lib/format';
import { dayName, localDayStart, nextDayStart } from '@/lib/listening-sessions';

/** How long after midnight the day moves on (a timer can fire a little early). */
const AFTER_MIDNIGHT_MS = 1000;

/**
 * Local midnight of today (epoch ms), moving on once a day, just after midnight, and
 * whenever the app comes back to the foreground (a suspended app runs no timers). For
 * labels that only change with the day ("Today", "Yesterday"): a list handed this
 * re-renders once a day, not every minute as with `useNow`.
 */
export function useToday(): number {
  const [today, setToday] = useState(() => localDayStart(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Wake just after the next local midnight (DST-safe: `nextDayStart`).
    const arm = () => {
      clearTimeout(timer);
      const now = Date.now();
      timer = setTimeout(tick, nextDayStart(localDayStart(now)) - now + AFTER_MIDNIGHT_MS);
    };
    const tick = () => {
      setToday(localDayStart(Date.now()));
      arm();
    };
    arm();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => {
      clearTimeout(timer);
      appState?.remove();
    };
  }, []);
  return today;
}

/**
 * The name of a day (`dayStart`, local midnight) as of `today` (`useToday`): Today,
 * Yesterday, else its weekday within the last week, else its date. `otherDay` names every
 * day before yesterday instead (the book page's History: "Sun 3 Oct").
 */
export function useDayLabel(otherDay?: (date: Date) => string) {
  const { t } = useTranslation();
  return (dayStart: number, today: number): string => {
    const name = dayName(dayStart, today);
    if (name === 'today') return t('journal.diary.today');
    if (name === 'yesterday') return t('journal.diary.yesterday');
    const date = new Date(dayStart);
    if (otherDay) return otherDay(date);
    return name === 'weekday'
      ? formatWeekday(date)
      : formatDayDate(date, getLocale(), new Date(today));
  };
}
