import type { BookMetaRecap } from '@/api/types';
import { chapterNumberAt, listeningProgressFor } from '@/components/library/meta-gating';
import { storySoFar } from '@/components/player/companion/companion-model';

/**
 * Home's "Previously on" card (STYLEGUIDE section 8): shown when the listener comes back
 * to the book they are on after a long gap. Pure, so the rules are tested.
 */

/** How long a gap earns a "Previously on" (days since the book was last played). */
export const PREVIOUSLY_ON_GAP_DAYS = 12;

/** How far before the saved place "Resume, with 30 seconds of overlap" starts. */
export const OVERLAP_S = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between `iso` and `now`, or null when `iso` doesn't parse. */
export function daysSince(iso: string | undefined, now: number): number | null {
  const then = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(then)) return null;
  return Math.floor(Math.max(0, now - then) / DAY_MS);
}

/** Where "Resume, with 30 seconds of overlap" starts: 30 s before the saved place, never
 * before the start. */
export function overlapStart(position: number): number {
  return Math.max(0, position - OVERLAP_S);
}

export type PreviouslyOnInput = {
  /** The book's saved place: its last save and whether it is finished. */
  saved?: { position: number; finished: boolean; updated_at: string };
  now: number;
  /** The book is the one loaded in the player (then the listener is not coming back). */
  loaded: boolean;
  /** The listener closed the card this session. */
  dismissed: boolean;
  /** The server's `metadata` capability (undefined while unknown). */
  metadata: boolean | undefined;
  /** The work's community recaps (empty: unmatched, or none written). */
  recaps: readonly BookMetaRecap[];
  /** The book's corrected chapter starts (`chapterStartsOf`), for the gate. */
  chapterStarts: readonly number[];
};

export type PreviouslyOn = {
  /** Days since the book was last played. */
  days: number;
  /** The recap paragraph to show: the furthest one the listener is past. */
  recap: BookMetaRecap;
  /** The 1-based chapter the saved place is in (0: before the first). */
  chapter: number;
};

/**
 * What the card shows, or null when it shouldn't show: only for an unfinished book
 * started and left 12 or more days ago, not loaded in the player, on a server with
 * community metadata whose recaps reach where the listener is (gated exactly as Story so
 * far: a recap shows once its last chapter is behind them), and not dismissed.
 */
export function previouslyOn(input: PreviouslyOnInput): PreviouslyOn | null {
  const { saved } = input;
  if (input.dismissed || input.loaded || input.metadata !== true) return null;
  if (!saved || saved.finished || saved.position <= 0) return null;
  const days = daysSince(saved.updated_at, input.now);
  if (days === null || days < PREVIOUSLY_ON_GAP_DAYS) return null;
  const progress = listeningProgressFor({
    chapterStarts: input.chapterStarts,
    position: saved.position,
    finished: false,
  });
  // The furthest part of Story so far (the companion's own gate) that has words.
  const recap = storySoFar(input.recaps, progress)
    .parts.reverse()
    .find((r) => r.text.trim().length > 0);
  if (!recap) return null;
  return { days, recap, chapter: chapterNumberAt(input.chapterStarts, saved.position) };
}
