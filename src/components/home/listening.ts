import type { ListeningDay, ListeningGoalStatus, StatsPeriod } from '@/api/types';

/**
 * The listening rules behind Home's This week card and the Now card's finish date, all in
 * SERVER time: a stats response's days are `YYYY-MM-DD` dates in the server's zone, so
 * "today" is the response's `to` moved by its `utc_offset`, never the device's clock.
 */

const DAY_MS = 86_400_000;

/** The server's date at the end of a stats period (`YYYY-MM-DD`), or null when `to` is
 * not a date. */
export function serverToday(period: Pick<StatsPeriod, 'to' | 'utc_offset'>): string | null {
  const at = Date.parse(period.to);
  if (Number.isNaN(at)) return null;
  return new Date(at + period.utc_offset * 60_000).toISOString().slice(0, 10);
}

/** A `YYYY-MM-DD` date moved by `n` days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday-first weekday of a `YYYY-MM-DD` date (0 = Monday ... 6 = Sunday). */
export function weekdayOf(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * The listening streak: consecutive days with any listening, counted back from today,
 * or from yesterday while nothing has been played yet today (a streak isn't broken
 * until the day is over). Days outside `days` count as none, so the streak is at most
 * the period's length.
 */
export function listeningStreak(days: readonly ListeningDay[], today: string): number {
  const listened = new Map(days.map((d) => [d.date, d.listened]));
  let day = (listened.get(today) ?? 0) > 0 ? today : addDays(today, -1);
  let streak = 0;
  while ((listened.get(day) ?? 0) > 0) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

export type DayBar = { date: string; listened: number; weekday: number; today: boolean };

/** The last seven days up to today, oldest first, for the weekly bars. */
export function lastSevenDays(days: readonly ListeningDay[], today: string): DayBar[] {
  const listened = new Map(days.map((d) => [d.date, d.listened]));
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i - 6);
    return { date, listened: listened.get(date) ?? 0, weekday: weekdayOf(date), today: i === 6 };
  });
}

/** Too little listening to project a pace from: fewer listening days than this... */
const MIN_PACE_DAYS = 3;
/** ...or less than this much listening in all (seconds). */
const MIN_PACE_SECONDS = 3600;

/**
 * The listener's pace: average seconds listened per day over `days` (every day of the
 * period, zeros included), or null when there is too little to go on (a pace from two
 * short sessions would promise a finish date nobody can keep).
 */
export function dailyPace(days: readonly ListeningDay[]): number | null {
  if (days.length === 0) return null;
  const active = days.filter((d) => d.listened > 0);
  const total = active.reduce((sum, d) => sum + d.listened, 0);
  if (active.length < MIN_PACE_DAYS || total < MIN_PACE_SECONDS) return null;
  return total / days.length;
}

/** When a book with `leftSeconds` of listening (at the listener's speed) is finished at
 * `pacePerDay`, counting today as the first day. */
export function estimatedFinish(leftSeconds: number, pacePerDay: number, now: Date): Date {
  const days = Math.max(0, Math.ceil(leftSeconds / pacePerDay) - 1);
  return new Date(now.getTime() + days * DAY_MS);
}

export type GoalProgress = {
  goal: number;
  finished: number;
  /** 0..1, for the ring. */
  fraction: number;
  /** Books still to finish this year (0 once the goal is met). */
  remaining: number;
  /** One book every N days keeps the goal (null once it is met). */
  everyDays: number | null;
};

/** The yearly goal as the This week card shows it, or null without a goal. `today` is
 * the server's date (the goal's year is the server's). */
export function goalProgress(status: ListeningGoalStatus, today: string): GoalProgress | null {
  const goal = status.goal?.books_per_year;
  if (!goal || goal <= 0) return null;
  const finished = Math.max(0, status.finished);
  const remaining = Math.max(0, goal - finished);
  const yearEnd = `${today.slice(0, 4)}-12-31`;
  const daysLeft = Math.round((Date.parse(yearEnd) - Date.parse(today)) / DAY_MS) + 1;
  return {
    goal,
    finished,
    fraction: Math.min(1, finished / goal),
    remaining,
    everyDays: remaining > 0 ? Math.max(1, Math.floor(daysLeft / remaining)) : null,
  };
}
