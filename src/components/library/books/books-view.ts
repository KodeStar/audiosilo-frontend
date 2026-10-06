import type { Book, Progress } from '@/api/types';
import { type LetterItem, letterItems } from '@/lib/alpha-sections';
import { foldAccents } from '@/lib/names';
import { firstParam, type RawParams } from '@/lib/paths';
import { isInProgress } from '@/lib/progress-view';

/**
 * The Library's Books mode as pure rules: the URL params it reads and writes (the
 * shared deep-link contract, `/library?mode=books&sort=&status=&dl=1&len=`), and the
 * filtering, counting and sorting it does ON THE DEVICE over the whole loaded list.
 */

export const BOOKS_SORTS = ['recent', 'title', 'author', 'length'] as const;
export type BooksSort = (typeof BOOKS_SORTS)[number];
export const DEFAULT_BOOKS_SORT: BooksSort = 'recent';

export const BOOK_STATUSES = ['new', 'progress', 'finished'] as const;
/** The listener's state of a book: never played, started, finished. */
export type BookStatus = (typeof BOOK_STATUSES)[number];

export const LENGTH_BUCKETS = ['short', 'mid', 'long'] as const;
/** Under 5 h, 5 to 15 h, over 15 h. */
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

/** What the Books mode shows: its sort and filters (all in the URL). */
export type BooksView = {
  sort: BooksSort;
  status?: BookStatus;
  /** Only books downloaded on this device. */
  dl: boolean;
  len?: LengthBucket;
};

const oneOf = <T extends string>(all: readonly T[], v: string): T | undefined =>
  (all as readonly string[]).includes(v) ? (v as T) : undefined;

/** The view a link asks for. Unknown values are ignored (the default stands). */
export function parseBooksView(params: RawParams): BooksView {
  return {
    sort: oneOf(BOOKS_SORTS, firstParam(params.sort)) ?? DEFAULT_BOOKS_SORT,
    status: oneOf(BOOK_STATUSES, firstParam(params.status)),
    dl: firstParam(params.dl) === '1',
    len: oneOf(LENGTH_BUCKETS, firstParam(params.len)),
  };
}

/** The URL params of a view, for `router.setParams`: a default is `undefined`, which
 * removes the param, so the plain Library link stays `/library`. */
export function booksViewParams(view: BooksView): Record<string, string | undefined> {
  return {
    sort: view.sort === DEFAULT_BOOKS_SORT ? undefined : view.sort,
    status: view.status,
    dl: view.dl ? '1' : undefined,
    len: view.len,
  };
}

/** Whether any filter narrows the list (the sort doesn't). */
export function hasFilters(view: BooksView): boolean {
  return !!view.status || view.dl || !!view.len;
}

/** The listener's progress rows by book path (one connection and library). */
export function progressByPath(rows: readonly Progress[]): Map<string, Progress> {
  return new Map(rows.map((p) => [p.path, p]));
}

export function bookStatus(progress: Progress | undefined): BookStatus {
  if (!progress) return 'new';
  if (progress.finished) return 'finished';
  return isInProgress(progress) ? 'progress' : 'new';
}

const HOUR = 3600;

export function lengthBucket(seconds: number): LengthBucket {
  if (seconds < 5 * HOUR) return 'short';
  return seconds <= 15 * HOUR ? 'mid' : 'long';
}

/** What the filters need to know about a book besides its own fields. */
export type BookFacts = { status: BookStatus; downloaded: boolean };

function matches(
  book: Book,
  facts: BookFacts,
  view: BooksView,
  skip?: 'status' | 'dl' | 'len',
): boolean {
  if (skip !== 'status' && view.status && facts.status !== view.status) return false;
  if (skip !== 'dl' && view.dl && !facts.downloaded) return false;
  if (skip !== 'len' && view.len && lengthBucket(book.duration) !== view.len) return false;
  return true;
}

export function filterBooks(
  books: readonly Book[],
  view: BooksView,
  factsOf: (book: Book) => BookFacts,
): Book[] {
  return books.filter((b) => matches(b, factsOf(b), view));
}

/** Each status chip's count: the books in that status among those the OTHER filters
 * keep (so a count says what pressing the chip would show). */
export function statusCounts(
  books: readonly Book[],
  view: BooksView,
  factsOf: (book: Book) => BookFacts,
): Record<BookStatus, number> {
  const out: Record<BookStatus, number> = { new: 0, progress: 0, finished: 0 };
  for (const b of books) {
    const facts = factsOf(b);
    if (matches(b, facts, view, 'status')) out[facts.status] += 1;
  }
  return out;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Leading English articles a title sort skips ("The Way of Kings" files under W). */
const ARTICLE = /^(the|an|a)\s+/i;

/** A title as it sorts and files: accents folded ("Émile" under E), a leading article
 * dropped, trimmed. */
export function titleKey(title: string): string {
  const trimmed = foldAccents(title).trim();
  const stripped = trimmed.replace(ARTICLE, '');
  // A title that IS an article ("A") keeps it.
  return stripped || trimmed;
}

/** A book with its sort keys worked out once, not on every comparison. */
type Keyed = { book: Book; title: string; added: number };

const COMPARE: Record<BooksSort, (a: Keyed, b: Keyed) => number> = {
  recent: (a, b) => b.added - a.added || b.book.id - a.book.id,
  title: (a, b) =>
    collator.compare(a.title, b.title) || collator.compare(a.book.author, b.book.author),
  author: (a, b) =>
    collator.compare(a.book.author, b.book.author) ||
    collator.compare(a.book.series, b.book.series) ||
    a.book.series_index - b.book.series_index ||
    collator.compare(a.title, b.title),
  length: (a, b) => b.book.duration - a.book.duration || collator.compare(a.title, b.title),
};

/** A sorted copy (books without a title sort by their folder name's title, as shown). */
export function sortBooks(books: readonly Book[], sort: BooksSort): Book[] {
  return books
    .map((book): Keyed => ({
      book,
      title: titleKey(book.title),
      added: book.added_at ? Date.parse(book.added_at) || 0 : 0,
    }))
    .sort(COMPARE[sort])
    .map((k) => k.book);
}

/** One cell of the Books grid: a book, or (title order) the letter head of a group. */
export type BooksGridItem = LetterItem<Book>;

/** The title-ordered grid: the books under their A-Z heads (see `letterItems`). */
export function letterGrid(sorted: readonly Book[]) {
  return letterItems(sorted, (b) => titleKey(b.title));
}

/** Where a book marked as not finished resumes. One stored at (or within a minute of)
 * its end would resume there and finish again at once, so it goes back to the start;
 * one marked finished mid-way keeps its place. */
export function unfinishedPosition(progress: Progress | undefined, duration: number): number {
  if (!progress) return 0;
  const end = Math.max(duration, progress.duration);
  return end > 0 && progress.position >= end - 60 ? 0 : progress.position;
}
