import type {
  Book,
  BookFile,
  BookMeta,
  BookMetaAttribution,
  BookMetaCharacter,
  BookMetaGenerated,
  BookMetaRecap,
  Chapter,
} from '@/api/types';
import { chapterBookOffset } from '@/playback/book-queue';

/**
 * How far the listener has got, expressed the way the community metadata talks
 * about position: a 1-based chapter NUMBER (0 = not started / unknown), plus
 * whether the book is finished (which reveals everything).
 *
 * A work's positions are numbered on its own scale, and `/meta` answers them translated
 * onto this book's chapters when the book splits finer than it (CROSS-REPO section 17), so
 * the comparison is like with like. Otherwise it sends the work's own numbers (a book no
 * finer than the scale, whose reveals come late unless its tracks are far from even; a work
 * stating no scale; an older server): there it is deliberately approximate; `finished` is
 * the escape hatch.
 */
export type ListeningProgress = { chapter: number; finished: boolean };

/**
 * How coarsely a spoiler-gated surface samples the player's live position (seconds),
 * for the book page and Search's characters. The gate only needs to know which CHAPTER
 * the listener is in, so subscribing to the per-tick position would re-render long lists
 * every second for nothing. Rounding DOWN can delay a reveal by at most this long at a
 * chapter boundary - it can never reveal something early, which is the direction that
 * matters. (The player's companion selects the chapter NUMBER instead,
 * `useListeningChapter`, so it reads the exact place.)
 */
export const LIVE_POSITION_BUCKET_S = 15;

/**
 * Whether a book's `/meta` is worth asking for: its server advertises `metadata` (an
 * older server omits it, and is never asked) and the book carries an ASIN or ISBN (a
 * book with neither can never match the community) or is `generated` (characters, recaps
 * or a description a Bridge generated on this server, which `/meta` serves:
 * `matched:false` with a `work`, Bridge Phases 1a and 1c). Never for a podcast episode
 * (`episode`: the community holds books, and a feed's tags can carry an ISBN-like value).
 * The player's companion and reveal toast, Home's Now card and Previously on, the end
 * credits and the offline copy ask by it: they ask for a book in passing, or for every
 * download, so they keep to the books that can match by id. The book page asks wider
 * (`bookPageMetaEnabled`); the series page's anchor and Search's characters pick their
 * books by their own rules (`metadataAnchor`, `characterBooksToLoad`).
 */
export function metaEnabledFor(
  metadata: boolean | undefined,
  book: Pick<Book, 'asin' | 'isbn' | 'generated' | 'episode'> | undefined,
): boolean {
  return bookPageMetaEnabled(metadata, book) && !!(book?.asin || book?.isbn || book?.generated);
}

/**
 * Whether the book page asks for its book's `/meta`: whenever its server advertises
 * `metadata` and the book is loaded and not a podcast episode, ids or not. A server
 * answers a book with no ASIN or ISBN from the match an admin saved in the console (a
 * LibriVox download rarely carries either, LibriVox L5), and an older server answers
 * `matched:false` for it without asking upstream, so the one request is cheap either way
 * and an unmatched answer renders as the page did without it. Only the one page a
 * listener opened asks like this; every other surface keeps `metaEnabledFor`. Never
 * before the book is in: until then the route's path may be a file inside the book, and
 * an episode is not yet known to be one.
 */
export function bookPageMetaEnabled(
  metadata: boolean | undefined,
  book: Pick<Book, 'episode'> | undefined,
): boolean {
  return metadata === true && !!book && !book.episode;
}

/**
 * Whether what a book's `/meta` says is in hand, for a decision that depends on it (the
 * Generate offer): the book is known and either `/meta` isn't asked for it (`enabled`,
 * `metaEnabledFor`, false: nothing to wait for) or its answer has arrived. A failed
 * lookup is no answer: the community may well have content the book just couldn't load.
 */
export function metaAnswered(
  enabled: boolean,
  book: object | undefined,
  meta: BookMeta | undefined,
): boolean {
  return enabled ? meta !== undefined : book !== undefined;
}

/** The community's CC BY-SA credit for one of a work's dimensions: the work's
 * `attribution`, unless that dimension was generated on this server (`work.generated`).
 * A matched work keeps the credit for its community content while generated characters
 * or recaps fill what it lacks, and generated content never carries the community's
 * credit. */
export function communityCredit(
  work: { attribution?: BookMetaAttribution; generated?: BookMetaGenerated } | undefined,
  dimension: 'characters' | 'recaps',
): BookMetaAttribution | undefined {
  return work?.generated?.[dimension] ? undefined : work?.attribution;
}

/** Where a Recaps panel's "Generated on this server" chips go and whether it carries the
 * community's credit (see `recapMarks`). */
export type RecapMarks = {
  /** Every part shown was generated here: one chip heads the panel. */
  panel: boolean;
  /** The parts disagree: a chip on the generated list, or on the generated summary. */
  list: boolean;
  summary: boolean;
  /** Some part shown is the community's: the panel ends with its CC BY-SA credit. */
  credit: boolean;
};

/**
 * How a Recaps panel marks its two parts, the recap list and the whole-book summary, by
 * where each came from: the summary is generated when `generated.recap_summary` (Bridge
 * Phase 1e), the list when `generated.recaps` (which the server also sets for a generated
 * summary, but it takes one only with its generated list, so a shown list it flags is
 * generated). A community summary beside a generated list keeps its credit. An older
 * server sends no `recap_summary`, so its `recaps` stands for the summary too: there a
 * community summary beside a generated list goes uncredited, as before 1e. `shown` says
 * which parts the panel renders.
 */
export function recapMarks(
  generated: BookMetaGenerated | undefined,
  shown: { list: boolean; summary: boolean },
): RecapMarks {
  const list = !!generated?.recaps;
  const summary = generated?.recap_summary ?? list;
  const generatedShown = (shown.list && list) || (shown.summary && summary);
  const communityShown = (shown.list && !list) || (shown.summary && !summary);
  const mixed = generatedShown && communityShown;
  return {
    panel: generatedShown && !communityShown,
    list: mixed && shown.list && list,
    summary: mixed && shown.summary && summary,
    credit: communityShown,
  };
}

/** Nothing known about the listener's position (no saved progress). */
const NO_PROGRESS: ListeningProgress = { chapter: 0, finished: false };

/**
 * Whether chapter starts say nothing about a place: several chapters the walk can reach,
 * every one at the same start. Out of order doesn't do that (the walk stops at the first
 * start past the position), and a NaN start, a file after one of unknown length, is never
 * reached. The same test as the server's `meta.startsAllAlike`.
 */
function startsAllAlike(starts: readonly number[]): boolean {
  let reachable = 0;
  for (const start of starts) {
    if (Number.isNaN(start)) break;
    if (start !== starts[0]) return false;
    reachable++;
  }
  return reachable > 1;
}

/**
 * 1-based ordinal of the chapter containing `position`, given each chapter's
 * whole-book start offset (ascending). 0 when there are no chapters or the
 * listener has not started - callers treat 0 as "only from-the-start entries". Also 0
 * when the starts say nothing about a place (`startsAllAlike`): a book whose every chapter
 * came back at offset 0 must not read as being in its last chapter, which reveals it all.
 * Past the last start, a run of starts alike at the end is one chapter's worth of place, the
 * run's first: files of unknown length after the last known one ([0, 3600, 3600, 3600]), or
 * markers of no length. The same walk as the server's `meta.ChapterAt`.
 *
 * Deliberately NOT `book-queue.ts`'s `chapterAt`: that one falls back to
 * `chapters[0]` (the player must always be *somewhere*), which here would claim
 * chapter 1 has been reached on a book nobody has started.
 */
export function chapterNumberAt(starts: readonly number[], position: number): number {
  if (starts.length === 0 || position <= 0 || startsAllAlike(starts)) return 0;
  let n = 0;
  for (let i = 0; i < starts.length; i++) {
    if (position >= starts[i]) n = i + 1;
    else break;
  }
  if (n === starts.length) {
    while (n > 1 && starts[n - 1] === starts[n - 2]) n--;
  }
  return n;
}

/**
 * The whole-book start offset of every chapter, recomputed from the cumulative file
 * durations (the server's `book_offset` is unreliable for some on-demand-indexed books,
 * so it is only used when there is no file list). Shared by the book page and Search's
 * character gate, so both place the listener on the same chapter.
 */
export function chapterStartsOf(
  chapters: Chapter[],
  files: Pick<BookFile, 'rel_path' | 'duration'>[],
): number[] {
  if (files.length === 0) return chapters.map((ch) => ch.book_offset);
  const fileDurations = files.map((f) => ({ path: f.rel_path, duration: f.duration }));
  return chapters.map((ch) => chapterBookOffset(fileDurations, ch));
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
  chapterStarts: readonly number[];
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
 * Whether a reveal is past the book's last chapter: the server's answer when the
 * character's unit starts inside a long last track, or a book coarser than the work's
 * scale. No place reaches it, so it waits for the finish, and "From chapter 7" would name a
 * chapter a 6-track book doesn't have. False when the count isn't known (0 or absent: no
 * chapters yet, or another book's numbers).
 */
export function revealIsPastEnd(c: BookMetaCharacter, chapterCount: number | undefined): boolean {
  return !!chapterCount && c.reveal.chapter > chapterCount;
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

/** How to head a recap. A chapter-0 "series" recap is the prior-books catch-up;
 * a chapter-0 "book" recap is a pre-book note; otherwise it covers up to chapter
 * N. Returns a descriptor the component maps to a translated string. */
export type RecapDescriptor =
  { kind: 'seriesPrior' } | { kind: 'beforeBook' } | { kind: 'upToChapter'; chapter: number };
export function recapDescriptor(recap: BookMetaRecap): RecapDescriptor {
  const ch = recap.through.chapter;
  if (ch === 0) return recap.scope === 'series' ? { kind: 'seriesPrior' } : { kind: 'beforeBook' };
  return { kind: 'upToChapter', chapter: ch };
}

/** Recaps ordered by position (ascending) so "story so far" reads in order. The
 * server already returns them ordered; this keeps every reader independent of
 * that. Returns a new array; does not mutate the input. */
export function sortRecaps(recaps: readonly BookMetaRecap[]): BookMetaRecap[] {
  return [...recaps].sort((a, b) => a.through.chapter - b.through.chapter);
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
