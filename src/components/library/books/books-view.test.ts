import type { Book, Progress } from '@/api/types';
import { sectionLetter } from '@/lib/alpha-sections';

import {
  type BookFacts,
  type BooksView,
  bookStatus,
  booksViewKey,
  booksViewParams,
  filterBooks,
  hasFilters,
  hasLabels,
  labelKey,
  labelOptions,
  lengthBucket,
  letterGrid,
  libraryBooksHref,
  parseBooksView,
  progressByPath,
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
    ).toEqual({
      sort: 'recent',
      status: undefined,
      dl: false,
      len: 'mid',
      genre: undefined,
      tag: undefined,
    });
  });

  it('reads a genre and a tag as given, trimmed, a blank one as none', () => {
    expect(parseBooksView({ genre: ' Science Fiction ', tag: ['to-read', 'x'] })).toMatchObject({
      genre: 'Science Fiction',
      tag: 'to-read',
    });
    expect(parseBooksView({ genre: '  ', tag: '' })).toMatchObject({
      genre: undefined,
      tag: undefined,
    });
  });

  it('writes defaults as absent params, so the plain link stays /library', () => {
    expect(booksViewParams({ sort: 'recent', dl: false })).toEqual({
      sort: undefined,
      status: undefined,
      dl: undefined,
      len: undefined,
      genre: undefined,
      tag: undefined,
    });
    expect(
      booksViewParams({
        sort: 'length',
        status: 'new',
        dl: true,
        len: 'short',
        genre: 'Fantasy',
        tag: 'Book club',
      }),
    ).toEqual({
      sort: 'length',
      status: 'new',
      dl: '1',
      len: 'short',
      genre: 'Fantasy',
      tag: 'Book club',
    });
  });

  it('round-trips', () => {
    const view = {
      sort: 'author',
      status: 'finished',
      dl: true,
      len: 'mid',
      genre: 'Fantasy',
      tag: 'Book club',
    } as const;
    expect(parseBooksView(booksViewParams(view))).toEqual(view);
  });

  it('links to the Books mode on a genre or a tag (a book page chip)', () => {
    expect(libraryBooksHref({ genre: 'Science Fiction & Fantasy' })).toEqual({
      pathname: '/library',
      params: { mode: 'books', genre: 'Science Fiction & Fantasy' },
    });
    expect(libraryBooksHref({ tag: ' to-read ' })).toEqual({
      pathname: '/library',
      params: { mode: 'books', tag: 'to-read' },
    });
    expect(libraryBooksHref({ genre: '  ' })).toEqual({
      pathname: '/library',
      params: { mode: 'books' },
    });
  });

  it('names a view by its sort and every filter', () => {
    const key = booksViewKey({ sort: 'recent', dl: false });
    expect(booksViewKey(parseBooksView({}))).toBe(key);
    const others = [
      booksViewKey({ sort: 'title', dl: false }),
      booksViewKey({ sort: 'recent', status: 'new', dl: false }),
      booksViewKey({ sort: 'recent', dl: true }),
      booksViewKey({ sort: 'recent', dl: false, len: 'short' }),
      booksViewKey({ sort: 'recent', dl: false, genre: 'Fantasy' }),
      booksViewKey({ sort: 'recent', dl: false, tag: 'Fantasy' }),
    ];
    expect(new Set([key, ...others]).size).toBe(7);
    // One label in any spelling is one view.
    expect(booksViewKey({ sort: 'recent', dl: false, genre: 'fantasy' })).toBe(others[4]);
  });

  it('knows when a filter narrows the list (sort alone does not)', () => {
    expect(hasFilters({ sort: 'title', dl: false })).toBe(false);
    expect(hasFilters({ sort: 'recent', dl: true })).toBe(true);
    expect(hasFilters({ sort: 'recent', dl: false, len: 'long' })).toBe(true);
    expect(hasFilters({ sort: 'recent', dl: false, genre: 'Fantasy' })).toBe(true);
    expect(hasFilters({ sort: 'recent', dl: false, tag: 'to-read' })).toBe(true);
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

describe('genre and tag filters', () => {
  const dune = book('Dune', { genres: ['Science Fiction'], tags: ['Book club', 'to-read'] });
  const hobbit = book('The Hobbit', { genres: ['Fantasy', 'Classics'], tags: ['TO-READ'] });
  const mistborn = book('Mistborn', { genres: ['fantasy', 'FANTASY'], duration: 20 * H });
  // An older server sends neither list.
  const plain = book('Plain');
  const books = [dune, hobbit, mistborn, plain];
  const facts: Record<string, BookFacts> = {
    [dune.rel_path]: { status: 'finished', downloaded: false },
    [hobbit.rel_path]: { status: 'progress', downloaded: false },
    [mistborn.rel_path]: { status: 'progress', downloaded: false },
    [plain.rel_path]: { status: 'new', downloaded: false },
  };
  const factsOf = (b: Book) => facts[b.rel_path];
  const view = (over: Partial<BooksView> = {}): BooksView => ({
    sort: 'recent',
    dl: false,
    ...over,
  });

  it('compares labels by trimmed, collapsed, lower-cased name', () => {
    expect(labelKey('  Science   Fiction ')).toBe('science fiction');
    expect(labelKey('FANTASY')).toBe(labelKey('fantasy'));
  });

  it('keeps the books with the label, in any spelling', () => {
    expect(filterBooks(books, view({ genre: 'FANTASY' }), factsOf)).toEqual([hobbit, mistborn]);
    expect(filterBooks(books, view({ genre: ' science  fiction ' }), factsOf)).toEqual([dune]);
    expect(filterBooks(books, view({ tag: 'To-Read' }), factsOf)).toEqual([dune, hobbit]);
    expect(filterBooks(books, view({ tag: 'to-read', genre: 'fantasy' }), factsOf)).toEqual([
      hobbit,
    ]);
    expect(filterBooks(books, view({ genre: 'Fantasy', len: 'long' }), factsOf)).toEqual([
      mistborn,
    ]);
    // A label no book has (another library's, or an older server's books) keeps none.
    expect(filterBooks(books, view({ genre: 'Horror' }), factsOf)).toEqual([]);
    expect(filterBooks([plain], view({ tag: 'to-read' }), factsOf)).toEqual([]);
  });

  it('is offered only for a library with that kind of label', () => {
    expect(hasLabels(books, 'genre')).toBe(true);
    expect(hasLabels([mistborn, plain], 'tag')).toBe(false);
    expect(hasLabels([plain], 'genre')).toBe(false);
    expect(hasLabels([book('Empty', { genres: [], tags: [] })], 'tag')).toBe(false);
  });

  it('lists each label once, first spelling, by name, counted among the other filters', () => {
    expect(labelOptions(books, view(), factsOf, 'genre')).toEqual([
      { key: 'classics', name: 'Classics', count: 1 },
      // Mistborn spells it twice and counts once; The Hobbit's spelling came first.
      { key: 'fantasy', name: 'Fantasy', count: 2 },
      { key: 'science fiction', name: 'Science Fiction', count: 1 },
    ]);
    expect(labelOptions(books, view(), factsOf, 'tag')).toEqual([
      { key: 'book club', name: 'Book club', count: 1 },
      { key: 'to-read', name: 'to-read', count: 2 },
    ]);
    // The counts follow the other filters (not its own), and a label they leave with
    // nothing drops out.
    expect(labelOptions(books, view({ status: 'progress' }), factsOf, 'genre')).toEqual([
      { key: 'classics', name: 'Classics', count: 1 },
      { key: 'fantasy', name: 'Fantasy', count: 2 },
    ]);
    expect(labelOptions(books, view({ genre: 'fantasy' }), factsOf, 'genre')).toHaveLength(3);
    expect(labelOptions(books, view({ genre: 'fantasy' }), factsOf, 'tag')).toEqual([
      { key: 'to-read', name: 'to-read', count: 1 },
    ]);
  });

  it('keeps the chosen label listed when nothing has it', () => {
    expect(labelOptions([plain], view({ tag: ' Horror ' }), factsOf, 'tag')).toEqual([
      { key: 'horror', name: 'Horror', count: 0 },
    ]);
    expect(labelOptions([plain], view(), factsOf, 'tag')).toEqual([]);
  });

  it('leaves the status counts to the label filters too', () => {
    expect(statusCounts(books, view({ genre: 'fantasy' }), factsOf)).toEqual({
      new: 0,
      progress: 2,
      finished: 0,
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

  it('sorts and files an untitled book by the folder name it is shown with', () => {
    const untitled = book('', { rel_path: 'Lib/Middlemarch' });
    const sorted = sortBooks([book('Zorba'), untitled, book('Anathem')], 'title');
    expect(sorted.map((b) => b.rel_path)).toEqual(['Lib/Anathem', 'Lib/Middlemarch', 'Lib/Zorba']);
    expect(
      letterGrid(sorted).items.map((i) => (i.kind === 'head' ? `#${i.letter}` : i.item.rel_path)),
    ).toEqual(['#A', 'Lib/Anathem', '#M', 'Lib/Middlemarch', '#Z', 'Lib/Zorba']);
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
