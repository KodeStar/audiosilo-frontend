import { chapterNumberAt } from '@/components/library/meta-gating';

/**
 * The Now card's whole-book scale (STYLEGUIDE section 8, "Now card"): one tick per
 * chapter, sized by its length, the chapters behind the listener in ink, the current one
 * in pink, the rest quiet. Pure, so the card only draws.
 */

export type ScaleState = 'past' | 'current' | 'ahead';
export type ScaleSegment = { weight: number; state: ScaleState };

/** More ticks than this would blur into a bar at card width, so neighbours merge. */
export const MAX_SCALE_SEGMENTS = 120;

/**
 * The scale's segments from the chapters' whole-book starts (ascending) and the book's
 * length. With no chapters it is a plain progress bar: what was heard, then the rest.
 * Past `max` chapters, runs of neighbours merge into one tick (the one holding the
 * current chapter is the current tick), so a 300-chapter book still reads as ticks.
 */
export function bookScale(
  starts: readonly number[],
  total: number,
  position: number,
  max = MAX_SCALE_SEGMENTS,
): ScaleSegment[] {
  if (total <= 0) return [];
  const at = Math.min(Math.max(position, 0), total);
  if (starts.length === 0) {
    return [
      { weight: at, state: 'past' as const },
      { weight: total - at, state: 'ahead' as const },
    ].filter((s) => s.weight > 0);
  }
  const current = Math.max(0, chapterNumberAt([...starts], at) - 1);
  const lengths = starts.map((s, i) => Math.max(0, (starts[i + 1] ?? total) - s));
  const per = Math.ceil(starts.length / max);
  const out: ScaleSegment[] = [];
  for (let i = 0; i < starts.length; i += per) {
    const last = Math.min(i + per, starts.length) - 1;
    const weight = lengths.slice(i, last + 1).reduce((a, b) => a + b, 0);
    const state: ScaleState = last < current ? 'past' : i > current ? 'ahead' : 'current';
    // A zero-length chapter still gets a sliver, so the tick count stays honest.
    out.push({ weight: Math.max(weight, total / 1000), state });
  }
  return out;
}

/** Where along the scale (0..1) each bookmark sits, dropping any outside the book. */
export function bookmarkPins(positions: readonly number[], total: number): number[] {
  if (total <= 0) return [];
  return positions.filter((p) => p >= 0 && p <= total).map((p) => p / total);
}

export type ChapterPlace = { number: number; count: number; title: string };

/** The chapter the listener is in (1-based, of how many), or null for a book without
 * chapters. Before the first chapter's start (or unstarted) it is chapter 1. */
export function chapterPlace(
  titles: readonly string[],
  starts: readonly number[],
  position: number,
): ChapterPlace | null {
  if (titles.length === 0 || starts.length !== titles.length) return null;
  const number = Math.max(1, chapterNumberAt([...starts], position));
  return { number, count: titles.length, title: titles[number - 1] ?? '' };
}

/** Whole percent heard: 100 only once finished, so an almost-done book reads 99%. */
export function percentHeard(position: number, total: number, finished: boolean): number {
  if (finished) return 100;
  if (total <= 0) return 0;
  return Math.min(99, Math.max(0, Math.floor((position / total) * 100)));
}

/** Listening left in wall-clock seconds at the book's own speed. */
export function timeLeftAtSpeed(position: number, total: number, speed: number): number {
  return Math.max(0, total - position) / (speed > 0 ? speed : 1);
}
