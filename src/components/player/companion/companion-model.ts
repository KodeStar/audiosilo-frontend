import type { BookMetaCharacter, BookMetaRecap, Chapter } from '@/api/types';
import {
  characterIsVisible,
  type ListeningProgress,
  sortRecaps,
  splitRecaps,
} from '@/components/library/meta-gating';
import { chapterEndPosition } from '@/playback/book-queue';
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

/** The characters reaching chapter `to` reveals that chapter `from` did not (the book
 * page's own visibility rule, applied at both places, in an unfinished book). */
export function newlyMet(
  characters: readonly BookMetaCharacter[],
  from: number,
  to: number,
): BookMetaCharacter[] {
  const at = (chapter: number): ListeningProgress => ({ chapter, finished: false });
  return characters.filter(
    (c) => characterIsVisible(c, at(to)) && !characterIsVisible(c, at(from)),
  );
}

/** One look at the playing book: where it is (whole-book seconds), whether it is
 * playing, and the 1-based chapter number the gate places it in. */
export type RevealSample = { position: number; playing: boolean; chapter: number };

/** The most a natural tick can move between two samples. Ticks arrive a few times a
 * second (a second apart at most on native), so even at 3x a tick moves a few seconds; a
 * skip of 15 s or more is the listener moving, not the book (well under the undo chip's
 * one-minute jump). */
export const NATURAL_STEP_S = 10;

/** Whether the book could have played from `prev` to `next` on its own: both samples
 * playing, time moving forward by no more than a tick. */
export function isNaturalStep(prev: RevealSample, next: RevealSample): boolean {
  const step = next.position - prev.position;
  return prev.playing && next.playing && step > 0 && step <= NATURAL_STEP_S;
}

/**
 * Whether going from `prev` to `next` is the book playing on into a new chapter (the
 * only moment the reveal toast fires): a natural step (`isNaturalStep`) with the chapter
 * number going up. A resume, a seek, a skip, a jump back or a stall is not a crossing.
 */
export function isNaturalCrossing(prev: RevealSample, next: RevealSample): boolean {
  return isNaturalStep(prev, next) && next.chapter > prev.chapter;
}

/** What the reveal watcher remembers between looks (`watchReveal`). */
export type RevealWatch = {
  /** The last playing sample taken as where the book is. */
  last: RevealSample | null;
  /** A playing sample that jumped away from `last`, held until the next one says what it
   * was: a seek or a skip (the book plays on from it), or one write of a file change the
   * native engine reports in two (the track, then the place in it: for that one write the
   * place is a whole file off). */
  jump: RevealSample | null;
  /** The furthest chapter taken this session: nobody before it is news. */
  reached: number;
};

export const REVEAL_WATCH_START: RevealWatch = { last: null, jump: null, reached: 0 };

/** A natural crossing to announce: the samples either side, and how far the session had
 * reached before it (`revealOnCrossing`'s inputs). */
export type RevealCrossing = { from: RevealSample; to: RevealSample; reached: number };

/**
 * One look of the reveal watcher at the playing book. `next` is null when it cannot be
 * placed (another book, or this one's load has not landed): the next sample starts over,
 * as a load. A sample that is not playing (a pause, a buffer, the moment between two
 * files) is passed over, so a chapter that starts with a new file still crosses from the
 * last playing sample before it. The first playing sample is where the book is (a load,
 * a resume), never a crossing. After that a sample a natural step from `last` is taken
 * (a crossing when the chapter went up) and drops any held jump as a glitch; one a
 * natural step from the held jump proves the jump real (a seek): both are taken, and the
 * jump is never a crossing; anything else is held as the jump.
 */
export function watchReveal(
  w: RevealWatch,
  next: RevealSample | null,
): { watch: RevealWatch; crossing: RevealCrossing | null } {
  if (!next) return { watch: { ...w, last: null, jump: null }, crossing: null };
  if (!next.playing) return { watch: w, crossing: null };
  const take = (reached: number, s: RevealSample): RevealWatch => ({
    last: s,
    jump: null,
    reached: Math.max(reached, s.chapter),
  });
  const step = (from: RevealSample, reached: number) => ({
    watch: take(reached, next),
    crossing: isNaturalCrossing(from, next) ? { from, to: next, reached } : null,
  });
  if (!w.last) return { watch: take(w.reached, next), crossing: null };
  if (isNaturalStep(w.last, next)) return step(w.last, w.reached);
  if (w.jump && isNaturalStep(w.jump, next)) {
    return step(w.jump, Math.max(w.reached, w.jump.chapter));
  }
  return { watch: { ...w, jump: next }, crossing: null };
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
  return newlyMet(characters, from, next.chapter);
}

/** Story so far: the recaps written up to where the listener is, in order, the chapter
 * the last one reaches (null when only the before-the-book recaps are reached), and how
 * many more are held back. */
export type StorySoFar = { parts: BookMetaRecap[]; upTo: number | null; hidden: BookMetaRecap[] };

export function storySoFar(recaps: readonly BookMetaRecap[], p: ListeningProgress): StorySoFar {
  const { visible, hidden } = splitRecaps(sortRecaps(recaps), p);
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
 * The chapter list's rows, from the chapters (ascending), the listener's place and speed:
 * earlier chapters ticked, the current one with the wall-clock time left in it (to its
 * end, `chapterEndPosition`: where the sleep sheet and the seek bar's times row put it
 * too), the later ones "in 2h 4m" (wall-clock time until they start). Times go through
 * `timeLeft`, the app's one speed rule.
 */
export function chapterRows(
  chapters: readonly Chapter[],
  position: number,
  current: number,
  speed: number,
): ChapterRow[] {
  return chapters.map((ch, i) => {
    if (i < current) return { state: 'past' };
    if (i === current) {
      const end = chapterEndPosition(ch);
      return { state: 'current', left: timeLeft(position, end, speed)?.seconds ?? 0 };
    }
    return { state: 'ahead', until: timeLeft(position, ch.book_offset, speed)?.seconds ?? 0 };
  });
}
