import type { ListeningDay, StatsTopName, UserStats } from '@/api/types';
import { addDays, weekdayOf } from '@/components/home/listening';

/**
 * The rules behind Your listening (the You hub's Stats section): every figure comes from
 * the server's own stats responses, in SERVER time (`today` is `serverToday(...)` of the
 * response, never the device's clock). Pure, so the charts stay drawings.
 */

/** Seconds listened per day, by `YYYY-MM-DD`. */
function byDate(days: readonly ListeningDay[]): Map<string, number> {
  return new Map(days.map((d) => [d.date, d.listened]));
}

// --- Weeks ---------------------------------------------------------------------------

/** How many weeks the Hours per week chart shows. */
export const WEEKS_SHOWN = 12;

/**
 * Seconds listened in each of the last `count` seven-day windows ending today, oldest
 * first: the last one is "this week" (the same rolling seven days Home's This week card
 * counts), the one before it "last week".
 */
export function weeklyTotals(
  days: readonly ListeningDay[],
  today: string,
  count = WEEKS_SHOWN,
): number[] {
  const listened = byDate(days);
  return Array.from({ length: count }, (_, i) => {
    const end = addDays(today, -(count - 1 - i) * 7);
    let sum = 0;
    for (let d = 0; d < 7; d++) sum += listened.get(addDays(end, -d)) ?? 0;
    return sum;
  });
}

/** This week against last week: `delta` is this minus last, in seconds. */
export function weekComparison(days: readonly ListeningDay[], today: string) {
  const [last, now] = weeklyTotals(days, today, 2);
  return { thisWeek: now, lastWeek: last, delta: now - last };
}

// --- Streaks and averages --------------------------------------------------------------

/** The longest run of consecutive days with any listening in `days` (oldest first, every
 * day present, as the server sends them). */
export function longestStreak(days: readonly ListeningDay[]): number {
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of days) {
    // A day missing from the list breaks the run, like a day without listening.
    const follows = prev !== null && addDays(prev, 1) === d.date;
    run = d.listened > 0 ? (follows ? run + 1 : 1) : 0;
    best = Math.max(best, run);
    prev = d.date;
  }
  return best;
}

/** Average seconds a day over `days` (zeros included), or 0 without days. */
export function dailyAverage(days: readonly ListeningDay[]): number {
  if (days.length === 0) return 0;
  return days.reduce((sum, d) => sum + d.listened, 0) / days.length;
}

/** Days with any listening. */
export function daysWithListening(days: readonly ListeningDay[]): number {
  return days.reduce((n, d) => n + (d.listened > 0 ? 1 : 0), 0);
}

// --- The listening calendar ------------------------------------------------------------

/** Weeks (columns) in the listening calendar. */
export const CALENDAR_WEEKS = 53;

export type CalendarCell = {
  date: string;
  listened: number;
  /** 0 (none) to 5 (most): the `seq-0..5` ramp. */
  level: number;
  today: boolean;
};

export type CalendarGrid = {
  /** `CALENDAR_WEEKS` columns of 7 (Monday first); null for days after today or before
   * the period. */
  columns: (CalendarCell | null)[][];
  /** A month label per column where that month's first day falls, `month` 0-11. */
  months: { column: number; month: number }[];
};

/**
 * The darkness of a day: 1-5 against the listener's own heavy days (the 95th percentile
 * of the days with listening, so one marathon doesn't wash every other day out), 0 for
 * none.
 */
export function levelScale(days: readonly ListeningDay[]): (listened: number) => number {
  const heard = days
    .map((d) => d.listened)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const top = heard.length ? heard[Math.min(heard.length - 1, Math.floor(heard.length * 0.95))] : 0;
  return (listened) => {
    if (listened <= 0 || top <= 0) return 0;
    return Math.max(1, Math.min(5, Math.ceil((5 * listened) / top)));
  };
}

/** The listening calendar: 53 Monday-first weeks ending with today's. */
export function calendarGrid(days: readonly ListeningDay[], today: string): CalendarGrid {
  const listened = byDate(days);
  const first = days.length ? days[0].date : today;
  const level = levelScale(days);
  const start = addDays(today, -weekdayOf(today) - (CALENDAR_WEEKS - 1) * 7);
  const columns: (CalendarCell | null)[][] = [];
  const months: { column: number; month: number }[] = [];
  for (let c = 0; c < CALENDAR_WEEKS; c++) {
    const column: (CalendarCell | null)[] = [];
    for (let r = 0; r < 7; r++) {
      const date = addDays(start, c * 7 + r);
      if (date > today || date < first) {
        column.push(null);
        continue;
      }
      const v = listened.get(date) ?? 0;
      column.push({ date, listened: v, level: level(v), today: date === today });
      if (date.endsWith('-01')) {
        const prev = months[months.length - 1];
        // Keep labels three columns apart, and none on the last column (no room).
        if ((!prev || c - prev.column >= 3) && c < CALENDAR_WEEKS - 1) {
          months.push({ column: c, month: Number(date.slice(5, 7)) - 1 });
        }
      }
    }
    columns.push(column);
  }
  return { columns, months };
}

/** The cell under a point of the calendar's grid (cells `cell` wide with `gap` between),
 * or null past its edges or on an empty slot. */
export function calendarCellAt(
  grid: CalendarGrid,
  x: number,
  y: number,
  cell: number,
  gap: number,
): CalendarCell | null {
  const pitch = cell + gap;
  const c = Math.floor(x / pitch);
  const r = Math.floor(y / pitch);
  if (c < 0 || r < 0 || c >= grid.columns.length || r >= 7) return null;
  return grid.columns[c][r] ?? null;
}

// --- The listening clock ---------------------------------------------------------------

/** Seconds listened in each hour of the day (0-23), summed over the weekdays of
 * `hour_weekday` (7 rows of 24). */
export function hourTotals(hourWeekday: readonly (readonly number[])[]): number[] {
  return Array.from({ length: 24 }, (_, h) =>
    hourWeekday.reduce((sum, row) => sum + (row?.[h] ?? 0), 0),
  );
}

/** A petal is a peak (drawn in brand) at this share of the busiest hour or more. */
export const PEAK_SHARE = 0.75;

export type ClockSummary = {
  hours: number[];
  max: number;
  /** The busiest hour, or null without listening. */
  busiest: number | null;
  peak: boolean[];
  /** Up to two peak windows, the biggest first: `from` to `to` (exclusive), hours 0-23. */
  windows: { from: number; to: number }[];
};

export function clockSummary(hourWeekday: readonly (readonly number[])[]): ClockSummary {
  const hours = hourTotals(hourWeekday);
  const max = Math.max(0, ...hours);
  const busiest = max > 0 ? hours.indexOf(max) : null;
  const peak = hours.map((v) => max > 0 && v >= max * PEAK_SHARE);
  // Runs of peak hours, wrapping past midnight.
  const runs: { from: number; to: number; total: number }[] = [];
  if (peak.some(Boolean) && !peak.every(Boolean)) {
    const startAt = peak.findIndex((p) => !p); // begin outside a run
    let run: { from: number; to: number; total: number } | null = null;
    for (let k = 1; k <= 24; k++) {
      const h = (startAt + k) % 24;
      if (peak[h]) {
        if (!run) run = { from: h, to: h, total: 0 };
        run.to = (h + 1) % 24;
        run.total += hours[h];
      } else if (run) {
        runs.push(run);
        run = null;
      }
    }
    if (run) runs.push(run);
  } else if (max > 0) {
    runs.push({ from: 0, to: 0, total: max });
  }
  runs.sort((a, b) => b.total - a.total);
  return {
    hours,
    max,
    busiest,
    peak,
    windows: runs.slice(0, 2).map(({ from, to }) => ({ from, to })),
  };
}

/** The clock's geometry at `size`: centre, inner and outer radius of the petals. */
export function clockGeometry(size: number) {
  return { c: size / 2, r0: size * 0.22, r1: size * 0.42 };
}

/** The smallest the stats page draws the clock. */
export const CLOCK_MIN_SIZE = 180;

/**
 * The width the clock's centre lines (the hour, "your busiest hour") are laid out in:
 * the inner circle less a small inset, whole points. A definite width, not the text's
 * own: Android sized a shrink-wrapped caption to one line and then drew it wrapped,
 * clipping the second line ("your busiest" without "hour").
 */
export function clockCentreWidth(size: number): number {
  return Math.floor(clockGeometry(size).r0 * 2) - 6;
}

/** The hour petal under a point of the clock, or null in the middle or outside it. */
export function petalAt(size: number, x: number, y: number): number | null {
  const { c, r0, r1 } = clockGeometry(size);
  const dx = x - c;
  const dy = y - c;
  const dist = Math.hypot(dx, dy);
  if (dist < r0 * 0.7 || dist > r1 + 12) return null;
  // 0 degrees at the top, clockwise.
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
  return Math.min(23, Math.floor(deg / 15));
}

/** The SVG path of hour `i`'s petal, `value` of `max` long. */
export function petalPath(size: number, i: number, value: number, max: number): string {
  const { c, r0, r1 } = clockGeometry(size);
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a0 = rad((i / 24) * 360 - 90 + 1.6);
  const a1 = rad(((i + 1) / 24) * 360 - 90 - 1.6);
  const rr = r0 + (r1 - r0) * (max > 0 ? Math.max(0.04, value / max) : 0.04);
  const p = (a: number, r: number) =>
    `${(c + Math.cos(a) * r).toFixed(1)} ${(c + Math.sin(a) * r).toFixed(1)}`;
  return `M${p(a0, r0)} L${p(a0, rr)} A${rr.toFixed(1)} ${rr.toFixed(1)} 0 0 1 ${p(a1, rr)} L${p(a1, r0)} A${r0.toFixed(1)} ${r0.toFixed(1)} 0 0 0 ${p(a0, r0)}Z`;
}

// --- Hours per week ------------------------------------------------------------------

const STEPS = [900, 1800, 3600, 2 * 3600, 4 * 3600, 5 * 3600, 10 * 3600, 20 * 3600, 50 * 3600];

/** A round axis for bars up to `max` seconds: at most four steps, from 0 to `top`. */
export function niceAxis(max: number): { top: number; ticks: number[] } {
  const step = STEPS.find((s) => s * 4 >= max) ?? Math.ceil(max / 4 / 3600) * 3600;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-6; v += step) ticks.push(v);
  return { top, ticks };
}

/** The bars' frame: the axis labels' gutter on the left, the week labels' below. */
export const BARS_FRAME = { height: 170, left: 34, bottom: 22, top: 8, bar: 18 } as const;

/** The week bar under `x` in a chart `width` wide, or null over the axis. */
export function barAt(width: number, x: number, count = WEEKS_SHOWN): number | null {
  const pitch = (width - BARS_FRAME.left) / count;
  if (x < BARS_FRAME.left || pitch <= 0) return null;
  return Math.min(count - 1, Math.floor((x - BARS_FRAME.left) / pitch));
}

// --- Rank lists ----------------------------------------------------------------------

export type RankRow = StatsTopName & { rank: number; fraction: number };

/** The top `limit` names with their share of the first one's time (the ink bar). */
export function rankRows(list: readonly StatsTopName[], limit = 5): RankRow[] {
  const rows = list.filter((r) => r.name.trim() && r.listened > 0).slice(0, limit);
  const max = rows[0]?.listened ?? 0;
  return rows.map((r, i) => ({ ...r, rank: i + 1, fraction: max > 0 ? r.listened / max : 0 }));
}

export type RankKind = 'author' | 'narrator' | 'series';

/**
 * The library an author, narrator or series page opens in. The stats name the field
 * value only, so: for an author, the library of a top or finished book of theirs; else
 * the library most of the year's books came from; null when the stats name none (the
 * caller falls back to the server's first library).
 */
export function libraryForName(
  stats: Pick<UserStats, 'top_books' | 'finished_books'>,
  kind: RankKind,
  name: string,
): number | null {
  const books = [...stats.top_books, ...stats.finished_books];
  if (kind === 'author') {
    const own = books.find((b) => b.author === name);
    if (own) return own.library_id;
  }
  const counts = new Map<number, number>();
  for (const b of books) counts.set(b.library_id, (counts.get(b.library_id) ?? 0) + 1);
  let best: number | null = null;
  let most = 0;
  for (const [lib, n] of counts) {
    if (n > most) {
      best = lib;
      most = n;
    }
  }
  return best;
}

// --- The yearly goal -----------------------------------------------------------------

export const GOAL_MIN = 1;
export const GOAL_MAX = 1000;

/** The values the -/+ buttons step through: every number to 12, then even numbers to 40,
 * then fives (and a value off the grid steps onto it). */
function onGoalGrid(v: number): boolean {
  return v <= 12 || (v <= 40 ? v % 2 === 0 : v % 5 === 0);
}

/** The goal one step up (`dir` 1) or down (-1), within 1-1000. */
export function nextGoal(goal: number, dir: 1 | -1): number {
  let v = Math.round(goal) + dir;
  while (v > GOAL_MIN && v < GOAL_MAX && !onGoalGrid(v)) v += dir;
  return Math.max(GOAL_MIN, Math.min(GOAL_MAX, v));
}

/** A first goal for a listener who has none: this year's pace carried to December (a
 * book a month at least), rounded up onto the step grid, and always ahead of the books
 * already finished. */
export function suggestedGoal(finished: number, today: string): number {
  const year = Number(today.slice(0, 4));
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const elapsed = Math.max(1, (Date.parse(`${today}T00:00:00Z`) - start) / 86_400_000 + 1);
  const share = Math.min(1, elapsed / ((end - start) / 86_400_000));
  let goal = Math.ceil(Math.max(12, finished + 1, finished / share));
  while (goal < GOAL_MAX && !onGoalGrid(goal)) goal++;
  return Math.min(GOAL_MAX, goal);
}

// --- Layout and servers ----------------------------------------------------------------

/** How many columns each block takes at a measured content `width`. */
export function statsColumns(width: number): { tiles: number; charts: number; ranks: number } {
  return {
    tiles: width >= 880 ? 4 : 2,
    charts: width >= 720 ? 2 : 1,
    ranks: width >= 940 ? 3 : width >= 600 ? 2 : 1,
  };
}

/** The width of one of `n` columns across `width` with `gap` between them. */
export function columnWidth(width: number, n: number, gap: number): number {
  return Math.max(0, Math.floor((width - gap * (n - 1)) / n));
}

/**
 * Which server's listening to show. The servers that keep stats (`user_stats` known on)
 * are the choices; a picker shows only when there are two or more. The listener's pick
 * holds while it keeps stats; else the default connection when it does, else the first
 * that does, else the default (which then explains it keeps none, or is still loading).
 */
export function statsServerChoice({
  connectionIds,
  userStats,
  defaultId,
  picked,
}: {
  connectionIds: readonly string[];
  /** Each connection's `user_stats` flag, undefined while not known. */
  userStats: Record<string, boolean | undefined>;
  defaultId: string;
  picked: string | null;
}): { cid: string; choices: string[] } {
  const choices = connectionIds.filter((id) => userStats[id] === true);
  if (picked && choices.includes(picked)) return { cid: picked, choices };
  if (choices.includes(defaultId) || userStats[defaultId] !== false || !choices.length) {
    return { cid: defaultId, choices };
  }
  return { cid: choices[0], choices };
}
