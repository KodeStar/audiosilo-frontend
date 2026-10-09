import { useShallow } from 'zustand/react/shallow';

import { chapterNumberAt } from '@/components/library/meta-gating';
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
 * The exact live whole-book position of the book `key` while it is the placed one
 * (`selectPlacedBookKey`), else undefined. The one reading of the live place for the
 * companion's gate (`useListeningChapter`) and its reveal toast, so the two agree.
 */
export function selectLivePosition(s: PlayerSlice, key: string): number | undefined {
  return selectPlacedBookKey(s) === key ? selectBookPosition(s) : undefined;
}

/**
 * The loaded book's live whole-book position in `bucketS` steps (rounded down) and
 * whether it has moved off 0, while `target` is that book (and placed,
 * `selectPlacedBookKey`); undefined otherwise. ONE selector per tick for both readings
 * of a book's place (`useBookPlace`).
 */
function useLiveBucket(
  target: PlayTarget | null | undefined,
  bucketS: number,
): { at: number; moved: boolean } | undefined {
  const key = target ? contentKey(target.connectionId, target.libraryId, target.path) : null;
  return usePlayer(
    useShallow((s) => {
      if (!key || selectPlacedBookKey(s) !== key) return undefined;
      const position = selectBookPosition(s);
      return { at: bucket(position, bucketS), moved: position > 0 };
    }),
  );
}

/**
 * Where the listener is in `target`, as whole-book positions, in `bucketS` steps
 * (rounded DOWN, so the caller re-renders once per step and a reveal can only come
 * late, never early):
 *
 * - `listening`, the spoiler rule's (`meta-gating`): the player's live position while
 *   that book is loaded (and placed, `selectPlacedBookKey`), never below the saved one
 *   (a live position that hasn't ticked yet can't take back what the saved one already
 *   showed), else the saved one.
 * - `resume`, where a press on Resume plays it from: the player's live place while that
 *   book is loaded and has moved off 0 (a press toggles it in place, from there), else
 *   the saved one. Unlike `listening` this CAN go below the saved place, and must: when
 *   another device (or the other app on the same phone) saved a place further on while
 *   this one held the book paused, the press still plays from the player's place, so
 *   "Resume chapter N", the percent and the current row name that one, as the time left
 *   (`useBookTimeLeft`), the Now card and the mini player already do. The spoiler gate
 *   keeps `listening` (a reveal is never taken back).
 */
export function useBookPlace(
  target: PlayTarget | null | undefined,
  saved: number | undefined,
  bucketS: number,
): { listening: number | undefined; resume: number | undefined } {
  const live = useLiveBucket(target, bucketS);
  return {
    listening: listeningPosition(live?.at, saved),
    resume: live?.moved ? live.at : saved,
  };
}

/** `useBookPlace`'s `resume`, for a caller that needs only that. */
export function useResumePosition(
  target: PlayTarget | null | undefined,
  saved: number | undefined,
  bucketS: number,
): number | undefined {
  return useBookPlace(target, saved, bucketS).resume;
}

/** The live position never below the saved one; the saved one when nothing is live. */
const listeningPosition = (live: number | undefined, saved: number | undefined) =>
  live === undefined ? saved : Math.max(live, saved ?? 0);

/**
 * The 1-based chapter the listener is in (`chapterNumberAt` on `chapterStarts`, 0 when
 * nothing is known): `useBookPlace`'s `listening` rule on the EXACT live place
 * (`selectLivePosition`), selected as a NUMBER, so a playing book re-renders the caller
 * only when the chapter changes. No bucket is needed for that (the number is the coarse
 * reading), so the chapter turns over at the boundary itself, never before the listener
 * reaches it. The companion's gate reads it, and the reveal toast reads the same place.
 */
export function useListeningChapter(
  target: PlayTarget,
  saved: number | undefined,
  chapterStarts: readonly number[],
): number {
  const key = contentKey(target.connectionId, target.libraryId, target.path);
  return usePlayer((s) => {
    const position = listeningPosition(selectLivePosition(s, key), saved);
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
