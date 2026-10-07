/**
 * The whole-book timeline's maths (STYLEGUIDE section 8, "Seek bar and chapter
 * timeline"): one segment per chapter, sized by its length, the chapters behind the
 * listener past, the current one with how much of it is heard, the rest ahead. Pure, so
 * the component only draws.
 */

export type TimelineState = 'past' | 'current' | 'ahead';

export type TimelineSegment = {
  /** Flex weight: the seconds it covers (never 0, so every chapter stays visible). */
  weight: number;
  state: TimelineState;
  /** How much of a `current` segment is heard, 0..1 (0 for the others). */
  played: number;
  /** The chapters it covers (indexes into the starts), first and last. */
  first: number;
  last: number;
};

/** The narrowest a segment is drawn, points; below it neighbours merge. */
export const MIN_SEGMENT_W = 3;
/** The gap between segments, points. */
export const SEGMENT_GAP = 2;

/** How many segments fit `width` points (Infinity before the first layout). */
export function maxSegmentsFor(width: number): number {
  if (!(width > 0)) return Infinity;
  return Math.max(1, Math.floor((width + SEGMENT_GAP) / (MIN_SEGMENT_W + SEGMENT_GAP)));
}

/** The index of the chapter holding `position` (0 before the first start). */
export function chapterIndexAt(starts: readonly number[], position: number): number {
  let index = 0;
  for (let i = 0; i < starts.length; i++) {
    if (position >= starts[i]) index = i;
    else break;
  }
  return index;
}

/**
 * The segments for chapters starting at `starts` (whole-book seconds, ascending) in a
 * book `total` long, the listener at `position`. Without chapters the whole book is one
 * segment. More chapters than `max` merge into runs of neighbours (the run holding the
 * listener is the current one), so a 300-chapter book still reads as a timeline.
 * Empty when the length is unknown.
 */
export function timelineSegments(
  starts: readonly number[],
  total: number,
  position: number,
  max = Infinity,
): TimelineSegment[] {
  if (!(total > 0)) return [];
  const at = Math.min(Math.max(position, 0), total);
  const chapters = starts.length > 0 ? starts : [0];
  const current = chapterIndexAt(chapters, at);
  const per = Math.max(1, Math.ceil(chapters.length / Math.max(1, max)));
  const out: TimelineSegment[] = [];
  for (let i = 0; i < chapters.length; i += per) {
    const last = Math.min(i + per, chapters.length) - 1;
    const from = i === 0 ? 0 : chapters[i];
    const to = chapters[last + 1] ?? total;
    const span = Math.max(0, to - from);
    const state: TimelineState = last < current ? 'past' : i > current ? 'ahead' : 'current';
    out.push({
      // A zero-length chapter still gets a sliver, so the count stays honest.
      weight: Math.max(span, total / 1000),
      state,
      played: state === 'current' && span > 0 ? Math.min(1, Math.max(0, (at - from) / span)) : 0,
      first: i,
      last,
    });
  }
  return out;
}

/** Where along the timeline (0..1) each position sits, dropping any outside the book. */
export function pinFractions(positions: readonly number[], total: number): number[] {
  if (!(total > 0)) return [];
  return positions.filter((p) => p >= 0 && p <= total).map((p) => p / total);
}
