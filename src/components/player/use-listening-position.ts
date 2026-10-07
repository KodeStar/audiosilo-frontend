import { useShallow } from 'zustand/react/shallow';

import { chapterNumberAt, LIVE_POSITION_BUCKET_S } from '@/components/library/meta-gating';
import { contentKey } from '@/lib/content-key';
import { selectBookKey, selectBookPosition, usePlayer } from '@/playback/store';

import type { PlayTarget } from './use-play-book';

const bucket = (position: number, bucketS: number) => Math.floor(position / bucketS) * bucketS;

/**
 * Where the listener is in `target`, as ONE whole-book position (the book page's
 * spoiler rule, `meta-gating`): the player's live position while that book is loaded,
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
    key && selectBookKey(s) === key ? bucket(selectBookPosition(s), bucketS) : undefined,
  );
  return listeningPosition(live, saved);
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
      selectBookKey(s) === key ? bucket(selectBookPosition(s), LIVE_POSITION_BUCKET_S) : undefined;
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
      const key = enabled ? selectBookKey(s) : null;
      return key ? { key, position: bucket(selectBookPosition(s), bucketS) } : null;
    }),
  );
}
