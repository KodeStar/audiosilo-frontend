import { useCallback, useMemo, useState } from 'react';

import { selectBookPosition, selectCurrentChapter, usePlayer } from '@/playback/store';

import { currentSegment, scrubTarget, type Segment } from './transport';

type PlayerSlice = ReturnType<typeof usePlayer.getState>;

const NONE: readonly number[] = [];

/** The playing book's segment (the chapter, else the book, or the file without a
 * whole-book timeline) with the live place in it; null with nothing loaded. */
export function selectPlayingSegment(s: PlayerSlice): Segment | null {
  const np = s.nowPlaying;
  if (!np) return null;
  return currentSegment({
    total: np.queue.total,
    bookPosition: selectBookPosition(s),
    chapter: selectCurrentChapter(s),
    trackPosition: s.snapshot.position,
    trackDuration: s.snapshot.duration,
  });
}

/** What a scrubber's segment is: a chapter, the whole book (a book with a whole-book
 * timeline but no chapters), or a file (no whole-book timeline). It names the scrubber
 * ("Position in chapter") and its times row ("21m left in the chapter"). */
export type SegmentKind = 'chapter' | 'book' | 'file';

/** The accessible name of a scrubber over a `kind` segment (i18n key). */
export const SEGMENT_LABEL = {
  chapter: 'player.seek.label',
  book: 'player.seek.labelBook',
  file: 'player.seek.labelFile',
} as const satisfies Record<SegmentKind, string>;

/** Seconds into `segment` with the player at `s`, held to its span. */
function elapsedIn(segment: Segment, s: PlayerSlice): number {
  const into = segment.perTrack ? s.snapshot.position : selectBookPosition(s) - segment.start;
  return Math.max(0, Math.min(segment.length, into));
}

/**
 * The playing segment for a scrubber (the full player's seek bar, the dock's chapter
 * scrubber): its shape (stable while the chapter plays) and `kind`, the seconds into it
 * (live, or in whole seconds where the caller only shows a clock), the seek that commits
 * a place in it (the whole book's seek, held short of the book's end by `scrubTarget` so
 * a scrub to the end of the last chapter does not finish the book; or the file's), and
 * which of `bookmarks` (whole-book seconds, from `usePlayingPins`) fall in it, as seconds
 * into it.
 *
 * `hold` (the caller's drag is on): the segment stays the one the drag started in. The
 * book plays on while the finger is down, and a chapter that ended mid-drag must not
 * swap the span under it: the release would land at that fraction of the NEXT chapter.
 */
export function usePlayingSegment(
  bookmarks: readonly number[] = NONE,
  { wholeSeconds = false, hold = false }: { wholeSeconds?: boolean; hold?: boolean } = {},
) {
  const total = usePlayer((s) => s.nowPlaying?.queue.total ?? 0);
  const chapter = usePlayer(selectCurrentChapter);
  const trackDuration = usePlayer((s) => s.snapshot.duration);
  const seekBook = usePlayer((s) => s.seekBook);
  const seekInTrack = usePlayer((s) => s.seekInTrack);

  const live = useMemo(
    () => currentSegment({ total, bookPosition: 0, chapter, trackPosition: 0, trackDuration }),
    [total, chapter, trackDuration],
  );
  const liveKind: SegmentKind = live.perTrack ? 'file' : chapter ? 'chapter' : 'book';
  // The segment the drag started in, captured on the render the drag turns `hold` on.
  const [held, setHeld] = useState<{ segment: Segment; kind: SegmentKind } | null>(null);
  if (hold && held === null) setHeld({ segment: live, kind: liveKind });
  else if (!hold && held !== null) setHeld(null);
  const { segment, kind } = hold && held ? held : { segment: live, kind: liveKind };

  const elapsed = usePlayer((s) => {
    const e = hold && held ? elapsedIn(held.segment, s) : (selectPlayingSegment(s)?.elapsed ?? 0);
    return wholeSeconds ? Math.floor(e) : e;
  });
  const { perTrack, start, length } = segment;
  const inSegment = useMemo(
    () =>
      perTrack
        ? NONE
        : bookmarks.filter((p) => p >= start && p < start + length).map((p) => p - start),
    [bookmarks, perTrack, start, length],
  );
  const onSeek = useCallback(
    (p: number) => (perTrack ? void seekInTrack(p) : void seekBook(scrubTarget(start + p, total))),
    [perTrack, start, total, seekBook, seekInTrack],
  );
  return { segment, kind, elapsed, onSeek, bookmarks: inSegment };
}
