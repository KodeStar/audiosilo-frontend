import type { Chapter } from '@/api/types';
import { chapterCountdowns, chapterEndPosition } from '@/playback/book-queue';
import {
  chapterSleepLabel,
  type SleepLabel,
  type SleepOrigin,
  type SleepPhase,
} from '@/playback/sleep-timer';

/** The sleep sheet's minute presets (STYLEGUIDE section 8, "Sheets"). */
export const SLEEP_MINUTES: readonly number[] = [5, 10, 15, 30, 45, 60];

/** "Or stop after": this chapter and up to three more. */
export const STOP_AFTER_ROWS = 4;

/** Half a second either way: chapter ends are float positions that the timer and the
 * sheet compute the same way, so this only absorbs rounding. */
const EPS = 0.5;

/** One "Or stop after" row: stop at the end of the `count`-th chapter from here (1 =
 * this one). `untilEnd` is wall-clock seconds at the current speed. */
export type StopAfterRow = {
  count: number;
  chapter: Chapter;
  endPosition: number;
  untilEnd: number;
};

/**
 * The "Or stop after" rows: this chapter and the next ones, at most `max`, and only as
 * many as the book has left. Only for a book with REAL chapters: the 30-minute markers
 * synthesized for a chapterless single file (`syntheticChapters`) are wall-clock slices,
 * and "stop after 3 chapters" over them would name an invented boundary.
 */
export function stopAfterRows(
  queue: { chapters: Chapter[]; total: number; syntheticChapters?: boolean },
  position: number,
  rate: number,
  max: number = STOP_AFTER_ROWS,
): StopAfterRow[] {
  if (queue.syntheticChapters || queue.chapters.length === 0) return [];
  return chapterCountdowns(queue.chapters, position, undefined, rate)
    .filter(
      (c) =>
        c.endPosition > position + EPS && (queue.total <= 0 || c.endPosition <= queue.total + EPS),
    )
    .slice(0, max)
    .map((c, i) => ({ ...c, count: i + 1 }));
}

/** The label a stop-after row arms: one chapter is "End of <chapter>" (as everywhere
 * else); more is "After 3 chapters". */
export function stopAfterLabel(row: StopAfterRow): SleepLabel {
  return row.count === 1
    ? chapterSleepLabel(row.chapter)
    : { key: 'player.sleepTimer.afterChapters', params: { count: row.count } };
}

/** What the sheet's notice says a running timer will do. */
export type SleepNotice =
  { kind: 'duration' } | { kind: 'book' } | { kind: 'chapters'; count: number };

/**
 * The notice headline for an armed timer: "Sleep timer on" for a duration timer,
 * "Stopping at the end of the book", or "Stopping at the end of this chapter / after N
 * chapters" - N counted LIVE from where the book is to where the timer stops, so an
 * "after 3 chapters" timer says 2 once a chapter has gone by.
 */
export function sleepNotice(
  origin: SleepOrigin | null,
  label: SleepLabel | null,
  pauseAtPosition: number | null,
  chapters: Chapter[],
  position: number,
): SleepNotice {
  if (origin?.kind !== 'chapter' || pauseAtPosition === null) return { kind: 'duration' };
  if (label?.key === 'player.sleepTimer.endOfBook') return { kind: 'book' };
  const count = chapters.filter((ch) => {
    const end = chapterEndPosition(ch);
    return end > position + EPS && end <= pauseAtPosition + EPS;
  }).length;
  return { kind: 'chapters', count: Math.max(1, count) };
}

/** Is this the timer the sheet would arm with `minutes`? (Selects the preset.) */
export function isDurationTimer(phase: SleepPhase, origin: SleepOrigin | null, minutes: number) {
  return phase !== 'idle' && origin?.kind === 'duration' && origin.minutes === minutes;
}

/** Does a running chapter timer stop at `endPosition`? (Selects a row or the tile.) */
export function stopsAt(phase: SleepPhase, pauseAtPosition: number | null, endPosition: number) {
  return (
    phase !== 'idle' && pauseAtPosition !== null && Math.abs(pauseAtPosition - endPosition) < EPS
  );
}
