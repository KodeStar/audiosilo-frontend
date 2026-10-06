import type { Book, Progress } from '@/api/types';
import { sectionLetter } from '@/lib/alpha-sections';

import {
  type BookFacts,
  bookStatus,
  booksViewParams,
  filterBooks,
  hasFilters,
  lengthBucket,
  letterGrid,
  parseBooksView,
  progressByPath,
  serverSort,
  sortBooks,
  statusCounts,
  titleKey,
  unfinishedPosition,
} from './books-view';

const H = 3600;

let nextId = 1;
const book = (title: string, over: Partial<Book> = {}): Book => ({
  id: nextId++,
  library_id: 1,
  rel_path: `Lib/${title}`,
  is_folder: true,
  title,
  author: '',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 3 * H,
  format: 'm4b',
  size: 0,
  ...over,
});

const progress = (path: string, over: Partial<Progress> = {}): Progress => ({
  library_id: 1,
  path,
  position: 60,
  duration: 3 * H,
  finished: false,
  playback_speed: 1,
  version: 1,
  device_id: 'd',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

describe('parseBooksView / booksViewParams', () => {
  it('reads the shared deep-link params and ignores unknown values', () => {
    expect(parseBooksView({ sort: 'title', status: 'progress', dl: '1', len: 'long' })).toEqual({
      sort: 'title',
      status: 'progress',
      dl: true,
      len: 'long',
    });
    expect(
      parseBooksView({ sort: 'rating', status: 'nope', dl: 'yes', len: ['mid', 'x'] }),
    ).toEqual({ sort: 'recent', status: undefined, dl: false, len: 'mid' });
  });

  it('writes defaults as absent params, so the plain link stays /library', () => {
    expect(booksViewParams({ sort: 'recent', dl: false })).toEqual({
      sort: undefined,
      status: undefined,
      dl: undefined,
      len: undefined,
    });
    expect(booksViewParams({ sort: 'length', status: 'new', dl: true, len: 'short' })).toEqual({
      sort: 'length',
      status: 'new',
      dl: '1',
      len: 'short',
    });
  });

  it('round-trips', () => {
    const view = { sort: 'author', status: 'finished', dl: true, len: 'mid' } as const;
    expect(parseBooksView(booksViewParams(view))).toEqual(view);
  });

  it('knows when a filter narrows the list (sort alone does not)', () => {
    expect(hasFilters({ sort: 'title', dl: false })).toBe(false);
    expect(hasFilters({ sort: 'recent', dl: true })).toBe(true);
    expect(hasFilters({ sort: 'recent', dl: false, len: 'long' })).toBe(true);
  });

  it('asks the server for newest first while a length order loads', () => {
    expect(serverSort('length')).toBe('recent');
    expect(serverSort('title')).toBe('title');
  });
});

describe('status and length', () => {
  it('derives the status from the progress row', () => {
    expect(bookStatus(undefined)).toBe('new');
    expect(bookStatus(progress('a', { position: 0 }))).toBe('new');
    expect(bookStatus(progress('a'))).toBe('progress');
    expect(bookStatus(progress('a', { finished: true, position: 0 }))).toBe('finished');
  });

  it('buckets lengths at 5 h and 15 h', () => {
    expect(lengthBucket(5 * H - 1)).toBe('short');
    expect(lengthBucket(5 * H)).toBe('mid');
    expect(lengthBucket(15 * H)).toBe('mid');
    expect(lengthBucket(15 * H + 1)).toBe('long');
  });

  it('indexes progress by path', () => {
    const map = progressByPath([progress('a'), progress('b', { finished: true })]);
    expect(map.get('b')?.finished).toBe(true);
    expect(map.get('c')).toBeUndefined();
  });
});

describe('filterBooks / statusCounts', () => {
  const short = book('Short', { duration: 2 * H });
  const mid = book('Mid', { duration: 8 * H });
  const long = book('Long', { duration: 20 * H });
  const books = [short, mid, long];
  const facts: Record<string, BookFacts> = {
    [short.rel_path]: { status: 'progress', downloaded: true },
    [mid.rel_path]: { status: 'finished', downloaded: false },
    [long.rel_path]: { status: 'progress', downloaded: false },
  };
  const factsOf = (b: Book) => facts[b.rel_path];

  it('keeps the books every active filter allows', () => {
    expect(filterBooks(books, { sort: 'recent', dl: false }, factsOf)).toHaveLength(3);
    expect(filterBooks(books, { sort: 'recent', status: 'progress', dl: false }, factsOf)).toEqual([
      short,
      long,
    ]);
    expect(filterBooks(books, { sort: 'recent', status: 'progress', dl: true }, factsOf)).toEqual([
      short,
    ]);
    expect(filterBooks(books, { sort: 'recent', dl: false, len: 'long' }, factsOf)).toEqual([long]);
  });

  it('counts each status among what the other filters keep, whatever status is chosen', () => {
    expect(statusCounts(books, { sort: 'recent', status: 'new', dl: false }, factsOf)).toEqual({
      new: 0,
      progress: 2,
      finished: 1,
    });
    expect(statusCounts(books, { sort: 'recent', dl: false, len: 'mid' }, factsOf)).toEqual({
      new: 0,
      progress: 0,
      finished: 1,
    });
  });
});

describe('titles and sorting', () => {
  it('files titles without a leading article or accents', () => {
    expect(titleKey('The Way of Kings')).toBe('Way of Kings');
    expect(titleKey('  A Psalm for the Wild-Built')).toBe('Psalm for the Wild-Built');
    expect(titleKey('An Echo')).toBe('Echo');
    expect(titleKey('Theory')).toBe('Theory');
    expect(titleKey('A')).toBe('A');
    expect(sectionLetter(titleKey('Émile and the Sea'))).toBe('E');
    expect(sectionLetter(titleKey('吾輩は猫である'))).toBe('#');
    expect(sectionLetter(titleKey('1984'))).toBe('#');
  });

  it('sorts by title ignoring articles and case, numbers naturally', () => {
    const list = [book('the way of Kings'), book('Book 10'), book('Book 2'), book('Anathem')];
    expect(sortBooks(list, 'title').map((b) => b.title)).toEqual([
      'Anathem',
      'Book 2',
      'Book 10',
      'the way of Kings',
    ]);
  });

  it('sorts newest first, then longest first, then by author and series', () => {
    const a = book('A', { added_at: '2026-01-01T00:00:00Z', duration: 1 * H, author: 'Zed' });
    const b = book('B', { added_at: '2026-03-01T00:00:00Z', duration: 9 * H, author: 'Amy' });
    const c = book('C', { duration: 4 * H, author: 'Amy', series: 'S', series_index: 1 });
    const d = book('D', { author: 'Amy', series: 'S', series_index: 0.5 });
    expect(sortBooks([a, b, c], 'recent').map((x) => x.title)).toEqual(['B', 'A', 'C']);
    expect(sortBooks([a, b, c], 'length').map((x) => x.title)).toEqual(['B', 'C', 'A']);
    expect(sortBooks([a, c, b, d], 'author').map((x) => x.title)).toEqual(['B', 'D', 'C', 'A']);
  });

  it('does not reorder its input', () => {
    const list = [book('B'), book('A')];
    sortBooks(list, 'title');
    expect(list.map((b) => b.title)).toEqual(['B', 'A']);
  });
});

describe('letterGrid', () => {
  it('files titles by their sort key under A-Z heads', () => {
    const sorted = sortBooks(
      [book('Babel'), book('The Body'), book('Anathem'), book('1984'), book('Émile')],
      'title',
    );
    expect(
      letterGrid(sorted).items.map((i) => (i.kind === 'head' ? `#${i.letter}` : i.item.title)),
    ).toEqual(['#A', 'Anathem', '#B', 'Babel', 'The Body', '#E', 'Émile', '##', '1984']);
  });
});

describe('unfinishedPosition', () => {
  it('sends a book finished at its end back to the start', () => {
    expect(unfinishedPosition(progress('a', { finished: true, position: 3 * H - 2 }), 3 * H)).toBe(
      0,
    );
  });

  it('keeps the place of a book marked finished mid-way', () => {
    expect(unfinishedPosition(progress('a', { finished: true, position: 600 }), 3 * H)).toBe(600);
  });

  it('starts at 0 without progress', () => {
    expect(unfinishedPosition(undefined, 3 * H)).toBe(0);
  });
});
