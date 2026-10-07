/**
 * Pure transport maths shared by every player surface (the full player, the docked
 * player bar): where the chapter scrubber is, and where previous/next chapter go.
 * Framework-free so it is unit-tested; the components feed it from the player store.
 */

import { pathLeaf } from '@/lib/paths';
import { toBookPosition } from '@/playback/book-queue';

/** The slice of the current chapter this needs (`Chapter` from the playback types). */
type ChapterSpan = { book_offset: number; start: number; end: number };

export type Segment = {
  /** No whole-book timeline (file durations unknown): navigate and scrub per FILE. */
  perTrack: boolean;
  /** Whole-book offset where the segment starts (0 per track). */
  start: number;
  /** Segment length in seconds (at least 1, so a bar never divides by zero). */
  length: number;
  /** Seconds into the segment, clamped to it. */
  elapsed: number;
};

/**
 * The segment the chapter scrubber shows: the current chapter, else the whole book; or,
 * when the whole-book timeline is unreliable (`total <= 0`), the current file.
 */
export function currentSegment({
  total,
  bookPosition,
  chapter,
  trackPosition,
  trackDuration,
}: {
  total: number;
  bookPosition: number;
  chapter: ChapterSpan | null;
  trackPosition: number;
  trackDuration: number;
}): Segment {
  if (total <= 0) {
    return { perTrack: true, start: 0, length: Math.max(1, trackDuration), elapsed: trackPosition };
  }
  const start = chapter ? chapter.book_offset : 0;
  const length = chapter ? Math.max(1, chapter.end - chapter.start) : total;
  return {
    perTrack: false,
    start,
    length,
    elapsed: Math.max(0, Math.min(length, bookPosition - start)),
  };
}

/** The whole-book offsets previous/next step between: chapters, else file boundaries. */
export function segmentStarts(queue: {
  chapters: readonly { book_offset: number }[];
  offsets: readonly number[];
}): number[] {
  return queue.chapters.length > 0 ? queue.chapters.map((c) => c.book_offset) : [...queue.offsets];
}

/** Where "next chapter" goes: the first boundary clearly after the position (1.5 s of
 * slack, so a press right after a jump doesn't land on the same boundary), if any. */
export function nextSegmentStart(starts: readonly number[], position: number): number | undefined {
  return starts.find((s) => s > position + 1.5);
}

/** Where "previous chapter" goes: the start of the current chapter, or - within its
 * first 3 seconds - the start of the one before (0 at the very beginning). */
export function previousSegmentStart(starts: readonly number[], position: number): number {
  const current = [...starts].reverse().find((s) => s <= position + 0.01) ?? 0;
  if (position - current > 3) return current;
  const prior = starts.filter((s) => s < current - 0.01);
  return prior.length ? prior[prior.length - 1] : 0;
}

/** The slice of the player store previous/next reads and drives (structural, so this
 * module stays framework-free and the tests pass a plain object). */
export type StepState = {
  nowPlaying: {
    queue: { total: number; chapters: readonly { book_offset: number }[]; offsets: number[] };
  } | null;
  snapshot: { trackIndex: number; position: number };
  seekBook: (bookPosition: number) => unknown;
  seekInTrack: (positionInTrack: number) => unknown;
  goToTrack: (index: number) => unknown;
};

/**
 * Previous (-1) / next (+1) on every player surface, read from the live state at press
 * time. With a whole-book timeline it steps between chapter (else file) boundaries;
 * without one (`total <= 0`) it steps per FILE, and "previous" restarts the current file
 * when more than 3 seconds in.
 */
export function stepSegment(state: StepState, dir: 1 | -1): void {
  const queue = state.nowPlaying?.queue;
  if (!queue) return;
  const { trackIndex, position } = state.snapshot;
  if (queue.total <= 0) {
    if (dir === -1 && position > 3) return void state.seekInTrack(0);
    return void state.goToTrack(trackIndex + dir);
  }
  const bookPosition = toBookPosition(queue.offsets, trackIndex, position);
  const starts = segmentStarts(queue);
  const target =
    dir === 1 ? nextSegmentStart(starts, bookPosition) : previousSegmentStart(starts, bookPosition);
  if (target !== undefined) void state.seekBook(target);
}

/** A file's name for a book without chapters: the leaf of the track's path (its id is
 * `<library>:<path>`), else `fallback` (the book's title). */
export function trackLabel(track: { id: string } | undefined, fallback: string): string {
  return (track && pathLeaf(track.id.split(':').slice(1).join(':'))) || fallback;
}
