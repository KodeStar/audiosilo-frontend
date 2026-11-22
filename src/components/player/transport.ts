/**
 * Pure transport maths shared by every player surface (the full player, the docked
 * player bar): where the chapter scrubber is, and where previous/next chapter go.
 * Framework-free so it is unit-tested; the components feed it from the player store.
 */

import { type FilePlace, pathLeaf } from '@/lib/paths';
import { quietly } from '@/lib/quietly';
import { FINISHED_TOLERANCE, toBookPosition } from '@/playback/book-queue';

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

/** The most a scrub lands short of the end of the book, seconds (`scrubGuard`). */
export const SCRUB_END_GUARD_S = 30;
const SCRUB_END_GUARD_SHARE = 0.1;

/** The least a scrub lands short of the end: past the last `FINISHED_TOLERANCE` seconds,
 * where a save would count the book finished. */
const SCRUB_END_GUARD_MIN_S = FINISHED_TOLERANCE + 1;

/** How far short of the end a scrub lands in a book `total` long: 30 s, which keeps the
 * 10 s Undo chip alive even at 2x, or a tenth of the book when that is less (30 s of a
 * one-minute book would leave half its bar dead, PLAYER-04), but never inside the
 * finished window (a 25 s trailer scrubbed to its end would save as finished). */
export function scrubGuard(total: number): number {
  return Math.min(
    SCRUB_END_GUARD_S,
    Math.max(SCRUB_END_GUARD_MIN_S, total * SCRUB_END_GUARD_SHARE),
  );
}

/**
 * Where a scrub to `bookPosition` (a tap, a drag's release or a key on the whole-book
 * timeline or a chapter scrubber) lands in a book `total` long: never on the very end.
 * A seek to the end is the book's natural end: it saves as finished, the end-of-book flow
 * clears what is playing (and with it the Undo chip) and the next play starts over at 0,
 * so a drag released past the right edge would lose the place for good. Landing
 * `scrubGuard(total)` short of it keeps the jump undoable, and a book only finishes by
 * playing out or by Mark as finished. Unchanged when the length is unknown.
 */
export function scrubTarget(bookPosition: number, total: number): number {
  return total > 0 ? Math.min(bookPosition, Math.max(0, total - scrubGuard(total))) : bookPosition;
}

/** The whole-book offsets previous/next step between: chapters, else file boundaries. */
export function segmentStarts(queue: {
  chapters: readonly { book_offset: number }[];
  offsets: readonly number[];
}): number[] {
  return queue.chapters.length > 0 ? queue.chapters.map((c) => c.book_offset) : [...queue.offsets];
}

/** How far ahead "next chapter" looks, so a press right after a jump doesn't land on the
 * same boundary. */
const NEXT_SLACK = 1.5;

/** Where "next chapter" goes: the first boundary clearly after the position (1.5 s of
 * slack, so a press right after a jump doesn't land on the same boundary), if any. */
export function nextSegmentStart(starts: readonly number[], position: number): number | undefined {
  return starts.find((s) => s > position + NEXT_SLACK);
}

/** Where "previous chapter" goes: the start of the current chapter, or - within its
 * first 3 seconds - the start of the one before (0 at the very beginning). */
export function previousSegmentStart(starts: readonly number[], position: number): number {
  const current = [...starts].reverse().find((s) => s <= position + 0.01) ?? 0;
  if (position - current > 3) return current;
  const prior = starts.filter((s) => s < current - 0.01);
  return prior.length ? prior[prior.length - 1] : 0;
}

/** A queue chapter as previous/next reads it: its whole-book start and, for files that
 * share a start, its file (`file_index` in the queue, -1 when unknown) and in-file start. */
type StepChapter = { book_offset: number; file_index?: number; file_path?: string; start?: number };

/**
 * Where "next chapter" goes in a book with files sharing a whole-book start (a file of
 * unknown length: its seconds run past the next file's start, so whole-book seconds do not
 * order the chapters, even in a later file). In file order instead: the first chapter after
 * the place in the playing file (`NEXT_SLACK` ahead), else the first chapter of a later
 * file; with no chapters, the next file. `undefined` at the last one; `null` when no files
 * share a start (whole-book seconds order them).
 */
function nextInFileOrder(
  queue: { chapters: readonly StepChapter[]; offsets: readonly number[] },
  trackIndex: number,
  position: number,
): { bookPosition: number; file?: FilePlace; track?: number } | undefined | null {
  const { offsets } = queue;
  if (trackIndex >= offsets.length || !offsets.some((o, i) => o === offsets[i - 1])) return null;
  if (queue.chapters.length === 0) {
    const track = trackIndex + 1;
    return track < offsets.length ? { bookPosition: offsets[track], track } : undefined;
  }
  let best: { bookPosition: number; file: FilePlace; index: number } | undefined;
  for (const ch of queue.chapters) {
    const index = ch.file_index ?? -1;
    if (index < trackIndex || index >= offsets.length || ch.file_path === undefined) continue;
    const pos = ch.start ?? ch.book_offset - offsets[index];
    if (index === trackIndex && !(pos > position + NEXT_SLACK)) continue;
    if (!best || index < best.index || (index === best.index && pos < best.file.pos))
      best = { bookPosition: ch.book_offset, file: { path: ch.file_path, pos }, index };
  }
  return best && { bookPosition: best.bookPosition, file: best.file };
}

/** The slice of the player store previous/next reads and drives (structural, so this
 * module stays framework-free and the tests pass a plain object). */
export type StepState = {
  nowPlaying: {
    queue: { total: number; chapters: readonly StepChapter[]; offsets: number[] };
  } | null;
  snapshot: { trackIndex: number; position: number };
  seekBook: (bookPosition: number, file?: FilePlace) => unknown;
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
    if (dir === -1 && position > 3) return quietly(state.seekInTrack(0));
    return quietly(state.goToTrack(trackIndex + dir));
  }
  if (dir === 1) {
    const inFiles = nextInFileOrder(queue, trackIndex, position);
    if (inFiles !== null) {
      if (inFiles?.track !== undefined) return quietly(state.goToTrack(inFiles.track));
      if (inFiles) quietly(state.seekBook(inFiles.bookPosition, inFiles.file));
      return;
    }
  }
  const bookPosition = toBookPosition(queue.offsets, trackIndex, position);
  const starts = segmentStarts(queue);
  const target =
    dir === 1 ? nextSegmentStart(starts, bookPosition) : previousSegmentStart(starts, bookPosition);
  if (target !== undefined) quietly(state.seekBook(target));
}

/** A file's name for a book without chapters: the leaf of the track's path (its id is
 * `<library>:<path>`), else `fallback` (the book's title). */
export function trackLabel(track: { id: string } | undefined, fallback: string): string {
  return (track && pathLeaf(track.id.split(':').slice(1).join(':'))) || fallback;
}
