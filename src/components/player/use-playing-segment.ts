import { useCallback, useMemo } from 'react';

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

/**
 * The playing segment for a scrubber (the full player's seek bar, the dock's chapter
 * scrubber): its shape (stable while the chapter plays), the seconds into it (live, or in
 * whole seconds where the caller only shows a clock), the seek that commits a place in it
 * (the whole book's seek, held short of the book's end by `scrubTarget` so a scrub to the
 * end of the last chapter does not finish the book; or the file's), and which of
 * `bookmarks` (whole-book seconds, from `usePlayingPins`) fall in it, as seconds into it.
 */
export function usePlayingSegment(
  bookmarks: readonly number[] = NONE,
  { wholeSeconds = false }: { wholeSeconds?: boolean } = {},
) {
  const total = usePlayer((s) => s.nowPlaying?.queue.total ?? 0);
  const chapter = usePlayer(selectCurrentChapter);
  const trackDuration = usePlayer((s) => s.snapshot.duration);
  const elapsed = usePlayer((s) => {
    const e = selectPlayingSegment(s)?.elapsed ?? 0;
    return wholeSeconds ? Math.floor(e) : e;
  });
  const seekBook = usePlayer((s) => s.seekBook);
  const seekInTrack = usePlayer((s) => s.seekInTrack);

  const segment = useMemo(
    () => currentSegment({ total, bookPosition: 0, chapter, trackPosition: 0, trackDuration }),
    [total, chapter, trackDuration],
  );
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
  return { segment, elapsed, onSeek, bookmarks: inSegment };
}
