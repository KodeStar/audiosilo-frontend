import type { Href } from 'expo-router';

import type { Book, Progress } from '@/api/types';
import { type LetterItem, letterItems } from '@/lib/alpha-sections';
import { bookLabels, LABEL_KINDS, type LabelKind, labelKey } from '@/lib/labels';
import { foldAccents } from '@/lib/names';
import { bookTitle, firstParam, type RawParams } from '@/lib/paths';
import { isInProgress } from '@/lib/progress-view';

/**
 * The Library's Books mode as pure rules: the URL params it reads and writes (the
 * shared deep-link contract, `/library?mode=books&sort=&status=&dl=1&len=&genre=&tag=`),
 * and the filtering, counting and sorting it does ON THE DEVICE over the whole loaded list.
 */

export const BOOKS_SORTS = ['recent', 'title', 'author', 'length'] as const;
export type BooksSort = (typeof BOOKS_SORTS)[number];
const DEFAULT_BOOKS_SORT: BooksSort = 'recent';

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
  /** Only books with this genre (any spelling of it: matched by `labelKey`). */
  genre?: string;
  /** Only books with this tag, as `genre`. */
  tag?: string;
};

const oneOf = <T extends string>(all: readonly T[], v: string): T | undefined =>
  (all as readonly string[]).includes(v) ? (v as T) : undefined;

/** A label param as given, trimmed; blank is none. */
const labelParam = (v: string | string[] | undefined): string | undefined =>
  firstParam(v).trim() || undefined;

/** The view a link asks for. Unknown values are ignored (the default stands). */
export function parseBooksView(params: RawParams): BooksView {
  return {
    sort: oneOf(BOOKS_SORTS, firstParam(params.sort)) ?? DEFAULT_BOOKS_SORT,
    status: oneOf(BOOK_STATUSES, firstParam(params.status)),
    dl: firstParam(params.dl) === '1',
    len: oneOf(LENGTH_BUCKETS, firstParam(params.len)),
    genre: labelParam(params.genre),
    tag: labelParam(params.tag),
  };
}

/** The Books view's URL params (`parseBooksView` reads them). */
export const BOOKS_VIEW_PARAMS = ['sort', 'status', 'dl', 'len', 'genre', 'tag'] as const;

/** The Library's Books mode showing `view`: the deep-link contract other screens open
 * (`/library?mode=books&sort=&status=&dl=1&len=&genre=&tag=`; a book page's genre and
 * tag chips open it on one). */
export function libraryBooksHref(view: Partial<BooksView>): Href {
  const params: Record<string, string> = { mode: 'books' };
  if (view.sort) params.sort = view.sort;
  if (view.status) params.status = view.status;
  if (view.dl) params.dl = '1';
  if (view.len) params.len = view.len;
  const genre = view.genre?.trim();
  if (genre) params.genre = genre;
  const tag = view.tag?.trim();
  if (tag) params.tag = tag;
  return { pathname: '/library', params };
}

/** The URL params of a view, for `router.setParams`: a default is `undefined`, which
 * removes the param, so the plain Library link stays `/library`. */
export function booksViewParams(view: BooksView): Record<string, string | undefined> {
  return {
    sort: view.sort === DEFAULT_BOOKS_SORT ? undefined : view.sort,
    status: view.status,
    dl: view.dl ? '1' : undefined,
    len: view.len,
    genre: view.genre,
    tag: view.tag,
  };
}

/** The identity of `view` (its sort and every filter), equal for equal views: the Books
 * list scopes its item keys to it, so a new order or filter is a new list. */
export function booksViewKey(view: BooksView): string {
  return [
    view.sort,
    view.status ?? '',
    view.dl ? 'dl' : '',
    view.len ?? '',
    labelKey(view.genre ?? ''),
    labelKey(view.tag ?? ''),
  ].join('|');
}

/** Whether any filter narrows the list (the sort doesn't). */
export function hasFilters(view: BooksView): boolean {
  return !!view.status || view.dl || !!view.len || !!view.genre || !!view.tag;
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

/** Each book's `labelKey`s, in its lists' order, worked out once per book: books are
 * immutable query data, and a library's whole list is filtered and counted on every
 * change of view. */
const labelKeyCache = new WeakMap<Book, Record<LabelKind, string[]>>();

function bookLabelKeys(book: Book, kind: LabelKind): string[] {
  let keys = labelKeyCache.get(book);
  if (!keys) {
    keys = {
      genre: bookLabels(book, 'genre').map(labelKey),
      tag: bookLabels(book, 'tag').map(labelKey),
    };
    labelKeyCache.set(book, keys);
  }
  return keys[kind];
}

/** Whether a book passes the view's filters (all but `skip`), with the view's labels
 * keyed once for the whole pass rather than once a book. */
function matcher(
  view: BooksView,
  skip?: 'status' | 'dl' | 'len' | LabelKind,
): (book: Book, facts: BookFacts) => boolean {
  const labels = LABEL_KINDS.flatMap((kind) => {
    const want = view[kind];
    return skip !== kind && want ? [{ kind, key: labelKey(want) }] : [];
  });
  return (book, facts) => {
    if (skip !== 'status' && view.status && facts.status !== view.status) return false;
    if (skip !== 'dl' && view.dl && !facts.downloaded) return false;
    if (skip !== 'len' && view.len && lengthBucket(book.duration) !== view.len) return false;
    return labels.every(({ kind, key }) => bookLabelKeys(book, kind).includes(key));
  };
}

export function filterBooks(
  books: readonly Book[],
  view: BooksView,
  factsOf: (book: Book) => BookFacts,
): Book[] {
  const keep = matcher(view);
  return books.filter((b) => keep(b, factsOf(b)));
}

/** Each status chip's count: the books in that status among those the OTHER filters
 * keep (so a count says what pressing the chip would show). */
export function statusCounts(
  books: readonly Book[],
  view: BooksView,
  factsOf: (book: Book) => BookFacts,
): Record<BookStatus, number> {
  const out: Record<BookStatus, number> = { new: 0, progress: 0, finished: 0 };
  const keep = matcher(view, 'status');
  for (const b of books) {
    const facts = factsOf(b);
    if (keep(b, facts)) out[facts.status] += 1;
  }
  return out;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Whether any book in the library has a `kind` label: the Books mode offers that
 * filter only then (an older server sends none, so it shows no new control). */
export function hasLabels(books: readonly Book[], kind: LabelKind): boolean {
  return books.some((b) => bookLabels(b, kind).length > 0);
}

/** One choice of a genre or tag filter. */
export type LabelOption = {
  /** `labelKey` of the label: what it matches by. */
  key: string;
  /** The label as the first book that has it spells it. */
  name: string;
  /** The books with it among those the OTHER filters keep. */
  count: number;
};

/**
 * The choices of the `kind` filter, by name: each label the books the OTHER filters keep
 * carry, once per `labelKey` (the first spelling met in the library), counted among
 * those books, so a count says what choosing it would show. The chosen label stays
 * listed even when no book has it (a link from another library, or a label since
 * removed).
 */
export function labelOptions(
  books: readonly Book[],
  view: BooksView,
  factsOf: (book: Book) => BookFacts,
  kind: LabelKind,
): LabelOption[] {
  const byKey = new Map<string, LabelOption>();
  const keep = matcher(view, kind);
  for (const b of books) {
    const names = bookLabels(b, kind);
    if (names.length === 0) continue;
    const keys = bookLabelKeys(b, kind);
    const kept = keep(b, factsOf(b));
    // The server sends each label once a book, so a book counts once for each.
    names.forEach((name, i) => {
      const option = byKey.get(keys[i]);
      if (option) option.count += kept ? 1 : 0;
      else byKey.set(keys[i], { key: keys[i], name, count: kept ? 1 : 0 });
    });
  }
  const chosen = view[kind]?.trim() ?? '';
  const chosenKey = labelKey(chosen);
  if (chosenKey && !byKey.has(chosenKey)) {
    byKey.set(chosenKey, { key: chosenKey, name: chosen, count: 0 });
  }
  return [...byKey.values()]
    .filter((o) => o.count > 0 || o.key === chosenKey)
    .sort((a, b) => collator.compare(a.name, b.name));
}

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

/** A book's title key as it is shown: its own title, else its folder or file name. */
const shownTitleKey = (book: Book) => titleKey(bookTitle(book.title, book.rel_path));

/** A sorted copy (books without a title sort by their folder name's title, as shown). */
export function sortBooks(books: readonly Book[], sort: BooksSort): Book[] {
  return books
    .map((book): Keyed => ({
      book,
      title: shownTitleKey(book),
      added: book.added_at ? Date.parse(book.added_at) || 0 : 0,
    }))
    .sort(COMPARE[sort])
    .map((k) => k.book);
}

/** One cell of the Books grid: a book, or (title order) the letter head of a group. */
export type BooksGridItem = LetterItem<Book>;

/** The title-ordered grid: the books under their A-Z heads (see `letterItems`). */
export function letterGrid(sorted: readonly Book[]) {
  return letterItems(sorted, shownTitleKey);
}

/** Where a book marked as not finished resumes. One stored at (or within a minute of)
 * its end would resume there and finish again at once, so it goes back to the start;
 * one marked finished mid-way keeps its place. */
export function unfinishedPosition(progress: Progress | undefined, duration: number): number {
  if (!progress) return 0;
  const end = Math.max(duration, progress.duration);
  return end > 0 && progress.position >= end - 60 ? 0 : progress.position;
}
