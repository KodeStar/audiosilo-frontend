import { useShallow } from 'zustand/react/shallow';

import { chapterNumberAt, LIVE_POSITION_BUCKET_S } from '@/components/library/meta-gating';
import { contentKey } from '@/lib/content-key';
import { selectBookKey, selectBookPosition, usePlayer } from '@/playback/store';

import type { PlayTarget } from './use-play-book';

/** `position` rounded DOWN to a `bucketS` step: the spoiler gate's live granularity. */
export const bucket = (position: number, bucketS: number) =>
  Math.floor(position / bucketS) * bucketS;

type PlayerSlice = ReturnType<typeof usePlayer.getState>;

/**
 * The loaded book whose place the snapshot holds (`selectBookKey`), or null: nothing
 * loaded, or a book just started whose engine load has not landed (`loadingBook`), when
 * the snapshot is still the PREVIOUS book's place and reading it as this book's would
 * gate (and reveal) by a position the listener has never reached. Every reader of the
 * live position for the spoiler gate goes through this.
 */
export function selectPlacedBookKey(s: PlayerSlice): string | null {
  const key = selectBookKey(s);
  return key !== null && s.loadingBook === key ? null : key;
}

/**
 * Where the listener is in `target`, as ONE whole-book position (the book page's
 * spoiler rule, `meta-gating`): the player's live position while that book is loaded
 * (and placed, `selectPlacedBookKey`),
 * never below the saved one (a live position that hasn't ticked yet can't take back
 * what the saved one already showed), else the saved one. The live position is read
 * in `bucketS` steps, rounded DOWN, so the caller re-renders once per step and a
 * reveal can only come late, never early.
 */
export function useListeningPosition(
  target: PlayTarget | null | undefined,
  saved: number | undefined,
  bucketS: number,
): number | undefined {
  const key = target ? contentKey(target.connectionId, target.libraryId, target.path) : null;
  const live = usePlayer((s) =>
    key && selectPlacedBookKey(s) === key ? bucket(selectBookPosition(s), bucketS) : undefined,
  );
  return listeningPosition(live, saved);
}

/**
 * Where a press on Resume plays `target` from, as ONE whole-book position: the player's
 * live place while that book is loaded (and placed) and has moved off 0 (a press toggles
 * it in place, from there), else the saved one. Rounded DOWN to `bucketS` steps.
 *
 * Unlike `useListeningPosition` this CAN go below the saved place, and must: when another
 * device (or the other app on the same phone) saved a place further on while this one
 * held the book paused, the press still plays from the player's place, so "Resume
 * chapter N", the percent and the current row name that one, as the time left
 * (`useBookTimeLeft`), the Now card and the mini player already do. The spoiler gate
 * keeps `useListeningPosition` (a reveal is never taken back).
 */
export function useResumePosition(
  target: PlayTarget | null | undefined,
  saved: number | undefined,
  bucketS: number,
): number | undefined {
  const key = target ? contentKey(target.connectionId, target.libraryId, target.path) : null;
  const live = usePlayer((s) => {
    if (!key || selectPlacedBookKey(s) !== key) return undefined;
    const position = selectBookPosition(s);
    // A load that has not ticked yet reads 0: keep the saved place until it has moved.
    return position > 0 ? bucket(position, bucketS) : undefined;
  });
  return live ?? saved;
}

/** The live position never below the saved one; the saved one when nothing is live. */
const listeningPosition = (live: number | undefined, saved: number | undefined) =>
  live === undefined ? saved : Math.max(live, saved ?? 0);

/**
 * The 1-based chapter the listener is in (`chapterNumberAt` on `chapterStarts`, 0 when
 * nothing is known): `useListeningPosition` at the spoiler gate's bucket, selected as a
 * NUMBER, so a playing book re-renders the caller only when the chapter changes.
 */
export function useListeningChapter(
  target: PlayTarget,
  saved: number | undefined,
  chapterStarts: readonly number[],
): number {
  const key = contentKey(target.connectionId, target.libraryId, target.path);
  return usePlayer((s) => {
    const live =
      selectPlacedBookKey(s) === key
        ? bucket(selectBookPosition(s), LIVE_POSITION_BUCKET_S)
        : undefined;
    const position = listeningPosition(live, saved);
    return position == null ? 0 : chapterNumberAt(chapterStarts, position);
  });
}

/**
 * The loaded book (its `contentKey`) and its live whole-book position in `bucketS`
 * steps (rounded down), or null when nothing is loaded or `enabled` is false: for a
 * screen that places the listener in several books at once (Search's characters).
 */
export function useLivePosition(
  bucketS: number,
  enabled = true,
): { key: string; position: number } | null {
  return usePlayer(
    useShallow((s) => {
      const key = enabled ? selectPlacedBookKey(s) : null;
      return key ? { key, position: bucket(selectBookPosition(s), bucketS) } : null;
    }),
  );
}
