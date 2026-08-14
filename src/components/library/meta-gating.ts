import type { BookMetaCharacter, BookMetaRecap } from '@/api/types';

/**
 * How far the listener has got, expressed the way the community metadata talks
 * about position: a 1-based chapter NUMBER (0 = not started / unknown), plus
 * whether the book is finished (which reveals everything).
 *
 * The meta layer's chapter numbers are the *work's* logical chapters and need not
 * line up with the local edition's chapter count - the comparison is numeric and
 * deliberately approximate; `finished` is the escape hatch.
 */
export type ListeningProgress = { chapter: number; finished: boolean };

/** Nothing known about the listener's position (no saved progress). */
const NO_PROGRESS: ListeningProgress = { chapter: 0, finished: false };

/**
 * 1-based ordinal of the chapter containing `position`, given each chapter's
 * whole-book start offset (ascending). 0 when there are no chapters or the
 * listener has not started - callers treat 0 as "only from-the-start entries".
 *
 * Deliberately NOT `book-queue.ts`'s `chapterAt`: that one falls back to
 * `chapters[0]` (the player must always be *somewhere*), which here would claim
 * chapter 1 has been reached on a book nobody has started.
 */
export function chapterNumberAt(starts: number[], position: number): number {
  if (starts.length === 0 || position <= 0) return 0;
  let n = 0;
  for (let i = 0; i < starts.length; i++) {
    if (position >= starts[i]) n = i + 1;
    else break;
  }
  return n;
}

/**
 * Where the listener is, for spoiler gating: ONE whole-book position - the
 * player's live one when this book is loaded, else the saved progress - mapped
 * onto the local chapter list, plus the saved `finished` flag.
 *
 * Taking a *position* is the point. It would be tempting to trust the player's
 * own chapter identity instead, but on a chapterless single-file book the queue
 * overlays *synthetic* 30-minute chapters (`synthesizeChapters`), whose indexes
 * are wall-clock slices rather than logical chapters - reading them as chapter
 * numbers reveals the whole cast an hour in. A position walked through
 * `chapterNumberAt` is the same mapping whether the book is playing or not, and a
 * book with no chapters at all simply gates to 0 (the "show anyway" toggle is the
 * escape hatch).
 */
export function listeningProgressFor(input: {
  /** Whole-book start offsets of the local chapters, ascending. */
  chapterStarts: number[];
  /** Freshest whole-book position in seconds, or null/undefined when nothing is known. */
  position: number | null | undefined;
  /** Whether the book is marked finished (reveals everything). */
  finished: boolean;
}): ListeningProgress {
  if (input.position == null) return { ...NO_PROGRESS, finished: input.finished };
  return {
    chapter: chapterNumberAt(input.chapterStarts, input.position),
    finished: input.finished,
  };
}

/**
 * Whether a character has been reached. A not-yet-started book still shows the
 * cast introduced in chapter 1 (`max(chapter, 1)`), which is what a listener
 * deciding whether to start expects to see; a finished book shows everyone.
 */
export function characterIsVisible(c: BookMetaCharacter, p: ListeningProgress): boolean {
  if (p.finished) return true;
  return c.reveal.chapter <= Math.max(p.chapter, 1);
}

/**
 * Whether a recap has been reached. A recap covering "up to chapter N" is only
 * safe once chapter N is *behind* you, so the test is strict (`<`); the chapter-0
 * recaps (prior books / before this book) are always safe.
 */
export function recapIsVisible(r: BookMetaRecap, p: ListeningProgress): boolean {
  if (p.finished) return true;
  return r.through.chapter === 0 || r.through.chapter < p.chapter;
}

/** Entries split into the ones reached and the ones held back as spoilers. */
export type Split<T> = { visible: T[]; hidden: T[] };

function split<T>(items: T[], keep: (item: T) => boolean): Split<T> {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const item of items) (keep(item) ? visible : hidden).push(item);
  return { visible, hidden };
}

export function splitCharacters(
  characters: BookMetaCharacter[],
  p: ListeningProgress,
): Split<BookMetaCharacter> {
  return split(characters, (c) => characterIsVisible(c, p));
}

export function splitRecaps(recaps: BookMetaRecap[], p: ListeningProgress): Split<BookMetaRecap> {
  return split(recaps, (r) => recapIsVisible(r, p));
}
