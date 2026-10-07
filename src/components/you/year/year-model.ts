import type { BookRef, ListeningDay, StatsTopBook, StatsTopName, UserStats } from '@/api/types';
import { hslHex, portraitHue } from '@/components/series/people-model';
import { hashString } from '@/lib/monogram';

import type { StoryTheme } from './story-themes';

/**
 * Year in listening (STYLEGUIDE section 8): the story cards a year of the listener's own
 * stats makes, all pure. Every card is built from real data on the wire (`/me/stats` for
 * the year, the current streak from `/me/listening`, the goal from `/me/goal`), in SERVER
 * time, and a card without data is left out rather than shown empty.
 */

/** Less listening than this (seconds) and no book finished: the year has no story yet. */
export const MIN_STORY_SECONDS = 3600;
/** The most spines the books card stacks (`finished_books` holds at most 100). */
export const MAX_TOWER = 48;
/** Days the streak card's little calendar shows: 12 weeks. */
export const STREAK_GRID_DAYS = 84;
/** A streak shorter than this is not a story. */
const MIN_STREAK = 2;
/** The oldest year the server accepts as a `range` (`StatsRange`). */
export const OLDEST_YEAR = 2000;

/** A spine in the books card's tower: its colours and its width (0..1 of the widest). */
export type TowerSpine = { key: string; title: string; body: string; band: string; width: number };

/** A cover on the summary card. */
export type StoryCover = BookRef & { title: string; author: string };

/** When most of the listening happens, from the busiest hour. */
export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

type Card<K extends string, D> = { kind: K; theme: StoryTheme } & D;

export type YearCard =
  | Card<
      'hours',
      { listened: number; sessions: number; books: number; wholeDays: number; estimated: number }
    >
  | Card<'books', { finished: number; spines: TowerSpine[]; goal: number | null }>
  | Card<'book', { book: StatsTopBook }>
  | Card<'voice', { narrator: StatsTopName; runnersUp: StatsTopName[] }>
  | Card<'clock', { hours: number[]; peak: number; part: DayPart }>
  | Card<'streak', { longest: number; current: number | null; grid: number[] }>
  | Card<'people', { author: StatsTopName | null; series: StatsTopName | null }>
  | Card<
      'summary',
      { listened: number; finished: number; longest: number; books: number; covers: StoryCover[] }
    >;

export type YearCardKind = YearCard['kind'];

export type YearInput = {
  stats: UserStats;
  /** Whether the year is the current one (asked for as `range=year`): only then is there a
   * goal for it and a streak still running. */
  current: boolean;
  /** The streak running today (server time), from `/me/listening?range=1y`; null when
   * not known or not this year. */
  currentStreak: number | null;
  /** Books per year, when the listener set a goal (this year only). */
  goal: number | null;
};

/** Whether a year has enough listening for a story (else the calm empty state). */
export function yearHasStory(stats: Pick<UserStats, 'totals'>): boolean {
  return stats.totals.listened >= MIN_STORY_SECONDS || stats.totals.finished > 0;
}

/** Whole hours, rounded ("412 hours"): the story's big number. */
export function roundHours(seconds: number): number {
  return Math.round(Math.max(0, seconds) / 3600);
}

/** The longest run of consecutive days with any listening in `days` (every day of the
 * period, oldest first, as the wire sends them), and the date it ended on. */
export function longestStreak(days: readonly ListeningDay[]): {
  length: number;
  end: string | null;
} {
  let best = 0;
  let end: string | null = null;
  let run = 0;
  let prev: string | null = null;
  for (const d of days) {
    if (d.listened > 0) {
      run = prev !== null && isNextDay(prev, d.date) ? run + 1 : 1;
      prev = d.date;
      if (run > best) {
        best = run;
        end = d.date;
      }
    } else {
      run = 0;
      prev = null;
    }
  }
  return { length: best, end };
}

/** Whether `b` is the day after `a` (`YYYY-MM-DD`): a gap in the list breaks a streak. */
function isNextDay(a: string, b: string): boolean {
  return Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`) === 86_400_000;
}

/** The 12 weeks of listening (seconds per day, oldest first) the streak card draws: the
 * days up to `end` (the last day of the period when it is still running, else the end of
 * the longest streak), at most `STREAK_GRID_DAYS`. */
export function streakGrid(days: readonly ListeningDay[], end: string | null): number[] {
  if (days.length === 0) return [];
  const at = end ? days.findIndex((d) => d.date === end) : -1;
  const last = at >= 0 ? at : days.length - 1;
  return days
    .slice(Math.max(0, last - STREAK_GRID_DAYS + 1), last + 1)
    .map((d) => Math.max(0, d.listened));
}

/** Seconds listened in each hour of the day (0-23), summed over the weekdays of the
 * wire's `hour_weekday` (7 rows of 24). A short or missing row counts as none. */
export function hourTotals(hourWeekday: readonly (readonly number[])[] | undefined): number[] {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const row of hourWeekday ?? []) {
    for (let h = 0; h < 24; h++) hours[h] += Math.max(0, row?.[h] ?? 0);
  }
  return hours;
}

/** The busiest hour (0-23; the earliest of a tie), or null without any listening. */
export function busiestHour(hours: readonly number[]): number | null {
  let peak: number | null = null;
  hours.forEach((v, h) => {
    if (v > 0 && (peak === null || v > hours[peak])) peak = h;
  });
  return peak;
}

/** The part of the day an hour falls in: 5-11 morning, 12-16 afternoon, 17-21 evening,
 * else night. */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** Lighter hues than a cover's cloth, so a tower reads on the books card's deep navy. */
function spineColors(title: string): { body: string; band: string } {
  const h = portraitHue(title);
  return { body: hslHex(h, 52, 58), band: hslHex(h, 50, 36) };
}

/** The tower of the books finished (newest first on the wire, so the newest lands on
 * top): at most `MAX_TOWER`, each spine a width from its title, so the stack looks
 * stacked by hand and keeps its shape between visits. */
export function towerSpines(finished: UserStats['finished_books']): TowerSpine[] {
  return finished
    .slice(0, MAX_TOWER)
    .reverse()
    .map((b, i) => ({
      key: `${b.library_id}:${b.path}:${i}`,
      title: b.title,
      ...spineColors(b.title || b.path),
      width: 0.55 + ((hashString(b.title || b.path) % 100) / 100) * 0.45,
    }));
}

/** Up to `max` covers for the summary card: the books finished (newest first), then the
 * most-listened, each book once. */
export function storyCovers(stats: UserStats, max = 6): StoryCover[] {
  const out: StoryCover[] = [];
  const seen = new Set<string>();
  for (const b of [...stats.finished_books, ...stats.top_books]) {
    const key = `${b.library_id}:${b.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ library_id: b.library_id, path: b.path, title: b.title, author: b.author });
    if (out.length === max) break;
  }
  return out;
}

const named = (rows: readonly StatsTopName[]) =>
  rows.filter((r) => r.name.trim() !== '' && r.listened > 0);

/**
 * The story of a year, in order: hours, books finished, book of the year, voice of the
 * year, when you listen, longest streak, author and series, then the summary to share.
 * Cards without data are left out; a year without a story (`yearHasStory`) has none.
 */
export function buildYearCards(input: YearInput): YearCard[] {
  const { stats, current } = input;
  if (!yearHasStory(stats)) return [];
  const cards: YearCard[] = [];
  const { totals } = stats;

  if (totals.listened >= MIN_STORY_SECONDS) {
    cards.push({
      kind: 'hours',
      theme: 'dusk',
      listened: totals.listened,
      sessions: totals.sessions,
      books: totals.books,
      wholeDays: Math.floor(totals.listened / 86_400),
      estimated: Math.max(0, stats.estimated ?? 0),
    });
  }

  if (totals.finished > 0) {
    cards.push({
      kind: 'books',
      theme: 'navy',
      finished: totals.finished,
      spines: towerSpines(stats.finished_books),
      goal: current && input.goal && input.goal > 0 ? input.goal : null,
    });
  }

  const book = stats.top_books.find((b) => b.listened > 0);
  if (book) cards.push({ kind: 'book', theme: 'sky', book });

  const narrators = named(stats.top_narrators);
  if (narrators.length > 0) {
    cards.push({
      kind: 'voice',
      theme: 'rose',
      narrator: narrators[0],
      runnersUp: narrators.slice(1, 3),
    });
  }

  const hours = hourTotals(stats.hour_weekday);
  const peak = busiestHour(hours);
  if (peak !== null) cards.push({ kind: 'clock', theme: 'teal', hours, peak, part: dayPart(peak) });

  const streak = longestStreak(stats.days);
  const running = current && input.currentStreak !== null ? input.currentStreak : null;
  if (streak.length >= MIN_STREAK) {
    const lastDay = stats.days[stats.days.length - 1]?.date ?? null;
    cards.push({
      kind: 'streak',
      theme: 'amber',
      longest: streak.length,
      current: running,
      // A streak still running shows the weeks up to today; an old one, its own weeks.
      grid: streakGrid(stats.days, running && running > 0 ? lastDay : streak.end),
    });
  }

  const author = named(stats.top_authors)[0] ?? null;
  const series = named(stats.top_series)[0] ?? null;
  if (author || series) cards.push({ kind: 'people', theme: 'violet', author, series });

  cards.push({
    kind: 'summary',
    theme: 'dusk',
    listened: totals.listened,
    finished: totals.finished,
    longest: streak.length,
    books: totals.books,
    covers: storyCovers(stats),
  });
  return cards;
}

/** Whether a probed year counts as having data, for the year picker: the same bar as a
 * story (`yearHasStory`), applied to a year's own totals or to the `previous` totals of
 * the year after it. */
export function hasData(totals: Pick<UserStats['totals'], 'listened' | 'finished'>): boolean {
  return totals.listened >= MIN_STORY_SECONDS || totals.finished > 0;
}

/** A shared card's file name: `audiosilo-2026-01-hours.png`. */
export function shareFileName(year: string, index: number, kind: YearCardKind): string {
  return `audiosilo-${year}-${String(index + 1).padStart(2, '0')}-${kind}.png`;
}
