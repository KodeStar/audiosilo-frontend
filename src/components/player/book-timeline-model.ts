import { scaleRuns, type ScaleRun } from '@/components/home/now-card-model';

/**
 * The whole-book timeline's maths (STYLEGUIDE section 8, "Seek bar and chapter
 * timeline"): one segment per chapter, merged into runs of neighbours like the Now card's
 * `scaleRuns` where there are more than fit, and placed by time (`runBox`). Pure, so the
 * component only draws.
 */

/** The narrowest a segment is drawn, points; below it neighbours merge. */
export const MIN_SEGMENT_W = 3;
/** The gap between segments, points. */
export const SEGMENT_GAP = 2;

/** How many segments fit `width` points (Infinity before the first layout). */
export function maxSegmentsFor(width: number): number {
  if (!(width > 0)) return Infinity;
  return Math.max(1, Math.floor((width + SEGMENT_GAP) / (MIN_SEGMENT_W + SEGMENT_GAP)));
}

/**
 * The timeline's segments for chapters starting at `starts` (whole-book seconds,
 * ascending) in a book `total` long, `width` points wide: one run per chapter, merged
 * where they would be too narrow to see. The first run starts at 0 (an intro before the
 * first chapter is part of it), so the runs cover the whole track; without chapters the
 * whole book is one. Independent of the listener's place. Empty when the length is
 * unknown.
 */
export function timelineRuns(starts: readonly number[], total: number, width: number): ScaleRun[] {
  const from0 = starts.length > 0 ? [0, ...starts.slice(1)] : [0];
  return scaleRuns(from0, total, maxSegmentsFor(width));
}

/**
 * Where `run` sits on the track, in percent of its width: from its start to its end by
 * time, the mapping the playhead, a tap, a drag, the hover tip and the pins all use
 * (x = t / total), so the segments line up with them. Not the runs' `weight`: that has a
 * floor (a sliver for a zero-length chapter, for the Now card), and with flex weights plus
 * fixed gaps a cluster of short chapters pushed every later segment away from the time it
 * stands for. The gap between segments is the drawing's business (carved out of each
 * run's own span), never added on top.
 */
export function runBox(run: ScaleRun, total: number): { left: number; width: number } {
  if (!(total > 0)) return { left: 0, width: 0 };
  // Multiply first: whole-second offsets then give exact percentages.
  return { left: (run.from * 100) / total, width: (Math.max(0, run.to - run.from) * 100) / total };
}

/** How much of `run` is heard with the listener at `at`, 0..1. */
export function heardIn(run: ScaleRun, at: number): number {
  const span = run.to - run.from;
  return span > 0 ? Math.min(1, Math.max(0, (at - run.from) / span)) : 0;
}
