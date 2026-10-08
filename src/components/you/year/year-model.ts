import type { BookRef, ListeningDay, StatsTopBook, StatsTopName, UserStats } from '@/api/types';
import { addDays, weekdayOf } from '@/components/home/listening';
import { hslHex, portraitHue } from '@/components/series/people-model';
import {
  clockSummary,
  levelScale,
  longestStreak,
  rankRows,
} from '@/components/you/stats/stats-model';
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
/** Weeks the streak card's little calendar shows at most. */
export const STREAK_GRID_WEEKS = 12;
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
  | Card<
      'streak',
      {
        longest: number;
        current: number | null;
        /** Monday-first weeks of 0-5 levels (`levelScale`), null outside the period. */
        grid: (number | null)[][];
      }
    >
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

/** Whether a year's totals (its own, or the `previous` ones of the year after it) have
 * enough listening for a story (else the calm empty state, and no place in the year
 * picker). */
export function yearHasStory(totals: Pick<UserStats['totals'], 'listened' | 'finished'>): boolean {
  return totals.listened >= MIN_STORY_SECONDS || totals.finished > 0;
}

/** Whole hours, rounded ("412 hours"): the story's big number. */
export function roundHours(seconds: number): number {
  return Math.round(Math.max(0, seconds) / 3600);
}

/** The streak card's little calendar: up to `STREAK_GRID_WEEKS` Monday-first weeks
 * ending with the week of `end` (the last day of the period when the streak is still
 * running, else the end of the longest streak), each day's level on the stats
 * calendar's own scale (`levelScale`), null outside the period. Weeks wholly before the
 * period are left out. */
export function streakGrid(days: readonly ListeningDay[], end: string | null): (number | null)[][] {
  if (days.length === 0) return [];
  const level = levelScale(days);
  const listened = new Map(days.map((d) => [d.date, d.listened]));
  const first = days[0].date;
  const last = end ?? days[days.length - 1].date;
  const start = addDays(last, -weekdayOf(last) - (STREAK_GRID_WEEKS - 1) * 7);
  const weeks: (number | null)[][] = [];
  for (let w = 0; w < STREAK_GRID_WEEKS; w++) {
    const week = Array.from({ length: 7 }, (_, d) => {
      const date = addDays(start, w * 7 + d);
      return date > last || date < first ? null : level(listened.get(date) ?? 0);
    });
    if (weeks.length > 0 || week.some((v) => v !== null)) weeks.push(week);
  }
  return weeks;
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

/**
 * The story of a year, in order: hours, books finished, book of the year, voice of the
 * year, when you listen, longest streak, author and series, then the summary to share.
 * Cards without data are left out; a year without a story (`yearHasStory`) has none.
 */
export function buildYearCards(input: YearInput): YearCard[] {
  const { stats, current } = input;
  if (!yearHasStory(stats.totals)) return [];
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

  const narrators = rankRows(stats.top_narrators, 3);
  if (narrators.length > 0) {
    cards.push({
      kind: 'voice',
      theme: 'rose',
      narrator: narrators[0],
      runnersUp: narrators.slice(1, 3),
    });
  }

  const { hours, busiest: peak } = clockSummary(stats.hour_weekday);
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

  const author = rankRows(stats.top_authors, 1)[0] ?? null;
  const series = rankRows(stats.top_series, 1)[0] ?? null;
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

/** A shared card's file name: `audiosilo-2026-01-hours.png`. */
export function shareFileName(year: string, index: number, kind: YearCardKind): string {
  return `audiosilo-${year}-${String(index + 1).padStart(2, '0')}-${kind}.png`;
}
