import type { BookMetaCharacter, BookMetaRecap } from '@/api/types';
import {
  characterIsVisible,
  type ListeningProgress,
  splitRecaps,
} from '@/components/library/meta-gating';
import { timeLeft } from '@/playback/time-left';

/**
 * The player's companion (STYLEGUIDE section 8, "Companion"): Who's who, Story so far,
 * Chapters, Bookmarks, Notes and History, beside the full player. Pure rules only; the
 * gating itself is `meta-gating.ts` (the book page's rules, never forked here).
 */

/** The companion's tabs, in order. */
export type CompanionTab = 'who' | 'story' | 'chapters' | 'bookmarks' | 'notes' | 'history';

/** Each tab's label (i18n keys): the companion's tabs and the phone's chips name them
 * the same way. */
export const COMPANION_TAB_LABEL = {
  who: 'player.companion.who',
  story: 'book.meta.storySoFar',
  chapters: 'player.chapters.chaptersTitle',
  bookmarks: 'player.bookmarks.label',
  notes: 'player.notes.label',
  history: 'player.companion.history',
} as const satisfies Record<CompanionTab, string>;

/** The tabs a book gets: the two community tabs only where the server has `metadata`
 * (an older server never shows them), the rest always (they are the listener's own). */
export function companionTabs(metadata: boolean): CompanionTab[] {
  const own: CompanionTab[] = ['chapters', 'bookmarks', 'notes', 'history'];
  return metadata ? ['who', 'story', ...own] : own;
}

/** The tab to show: the one asked for when it exists, else the first. */
export function activeCompanionTab(
  tabs: readonly CompanionTab[],
  wanted: CompanionTab | null,
): CompanionTab {
  return wanted && tabs.includes(wanted) ? wanted : tabs[0];
}

/** Who's who order: newest first (the latest first appearance on top), so the person
 * the listener just met leads. Stable for equal chapters (the server's order). */
export function whoOrder(characters: readonly BookMetaCharacter[]): BookMetaCharacter[] {
  return characters
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.reveal.chapter - a.c.reveal.chapter || a.i - b.i)
    .map((e) => e.c);
}

/** The characters `to` reveals that `from` did not (the book page's own visibility rule,
 * applied at both places). A finished book has no one new to meet. */
export function newlyMet(
  characters: readonly BookMetaCharacter[],
  from: ListeningProgress,
  to: ListeningProgress,
): BookMetaCharacter[] {
  if (to.finished || from.finished) return [];
  return characters.filter((c) => characterIsVisible(c, to) && !characterIsVisible(c, from));
}

/** One look at the playing book: where it is (whole-book seconds), whether it is
 * playing, and the 1-based chapter number the gate places it in. */
export type RevealSample = { position: number; playing: boolean; chapter: number };

/** The most a natural tick can move between two samples. Ticks arrive a few times a
 * second (a second apart at most on native), so even at 3x a tick moves a few seconds; a
 * skip of 15 s or more is the listener moving, not the book (well under the undo chip's
 * one-minute jump). */
export const NATURAL_STEP_S = 10;

/**
 * Whether going from `prev` to `next` is the book playing on into a new chapter (the
 * only moment the reveal toast fires): both samples playing, time moving forward by no
 * more than a tick, and the chapter number going up. A resume, a seek, a skip, a jump
 * back or a stall is not a crossing.
 */
export function isNaturalCrossing(prev: RevealSample, next: RevealSample): boolean {
  const step = next.position - prev.position;
  return (
    prev.playing &&
    next.playing &&
    step > 0 &&
    step <= NATURAL_STEP_S &&
    next.chapter > prev.chapter
  );
}

/**
 * Who to announce when the book goes from `prev` to `next`: nobody unless that is a
 * natural crossing; else the characters the new chapter reveals that were not already
 * met, counting from the furthest chapter this session has seen (`reached`), so going
 * back and playing through a chapter again never announces anyone twice.
 */
export function revealOnCrossing(
  characters: readonly BookMetaCharacter[],
  prev: RevealSample,
  next: RevealSample,
  reached: number,
  finished: boolean,
): BookMetaCharacter[] {
  if (finished || !isNaturalCrossing(prev, next)) return [];
  const from = Math.max(prev.chapter, reached);
  if (next.chapter <= from) return [];
  return newlyMet(
    characters,
    { chapter: from, finished: false },
    { chapter: next.chapter, finished: false },
  );
}

/** Story so far: the recaps written up to where the listener is, in order, the chapter
 * the last one reaches (null when only the before-the-book recaps are reached), and how
 * many more are held back. */
export type StorySoFar = { parts: BookMetaRecap[]; upTo: number | null; hidden: BookMetaRecap[] };

export function storySoFar(recaps: readonly BookMetaRecap[], p: ListeningProgress): StorySoFar {
  // In story order (the book page's `sortRecaps` rule; that module draws, this one doesn't).
  const ordered = [...recaps].sort((a, b) => a.through.chapter - b.through.chapter);
  const { visible, hidden } = splitRecaps(ordered, p);
  const last = visible[visible.length - 1];
  return {
    parts: visible,
    upTo: last && last.through.chapter > 0 ? last.through.chapter : null,
    hidden,
  };
}

/** One row of the companion's chapter list. */
export type ChapterRow =
  | { state: 'past' }
  /** The chapter playing: what is left of it, at the listener's speed. */
  | { state: 'current'; left: number }
  /** A later chapter: how long until it starts, at the listener's speed. */
  | { state: 'ahead'; until: number };

/**
 * The chapter list's rows, from each chapter's whole-book start (ascending), the book's
 * length, the listener's place and speed: earlier chapters ticked, the current one with
 * the wall-clock time left in it, the later ones "in 2h 4m" (wall-clock time until they
 * start). Times go through `timeLeft`, the app's one speed rule.
 */
export function chapterRows(
  starts: readonly number[],
  total: number,
  position: number,
  current: number,
  speed: number,
): ChapterRow[] {
  return starts.map((start, i) => {
    if (i < current) return { state: 'past' };
    if (i === current) {
      const end = starts[i + 1] ?? total;
      return { state: 'current', left: timeLeft(position, end, speed)?.seconds ?? 0 };
    }
    return { state: 'ahead', until: timeLeft(position, start, speed)?.seconds ?? 0 };
  });
}
