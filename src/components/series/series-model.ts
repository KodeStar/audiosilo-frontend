import type { Book, BookMetaSeries, BookMetaSeriesWork, CoverColor, Progress } from '@/api/types';
import { contentKey } from '@/lib/content-key';
import { foldAccents } from '@/lib/names';
import { isInProgress, progressFractionRemaining } from '@/lib/progress-view';
import type { SeriesView } from '@/lib/series-orderings';

/**
 * The series page's model (pure, tested): one ordered list of ENTRIES, built from the
 * listener's own books in the series plus, when the server matched one of them to the
 * community metadata, the series rail in the chosen reading order.
 *
 * An entry is one of three kinds:
 * - `owned`: a book on this connection's server (any library: a rail entry's `local`
 *   can point at another library than the page's);
 * - `elsewhere`: not on this server, but a copy is on another connected server ("On
 *   Maya's Shelf"), found by title (and author) among that server's books;
 * - `ghost`: on no server the listener can reach. A community ghost has its real title
 *   and a link out; a LOCAL gap (no community data: an integer missing between the
 *   owned books' `series_index`es) is only "Book 3".
 */

/** Where an entry can be played or opened: a book on one connection. `book` is its list
 * row when loaded (a rail entry in another library starts without one). */
export type SeriesCopy = {
  connectionId: string;
  connectionName: string;
  libraryId: number;
  path: string;
  book?: Book;
};

type EntryFields = {
  /** Stable across reading orders (the work id when there is one), for keys and moves. */
  key: string;
  /** Its place in the shown order ("3", "2.5"), '' when it has none. */
  position: string;
  /** Absent only for a local gap, which has no title to show. */
  title?: string;
  workId?: string;
  /** The work's page on the metadata site (community entries only). */
  webUrl?: string;
  /** Listening length in seconds, when a copy is known. */
  seconds?: number;
  /** 0..1 listened (1 when finished). */
  fraction: number;
  started: boolean;
  finished: boolean;
  updatedAt?: string;
  /** "2012", from the copy's `published`. */
  year?: string;
  narrator?: string;
  coverColor?: CoverColor;
  coverVersion?: string;
};

/** One entry of the series: a book with a copy to play or open (`owned` here,
 * `elsewhere` on another server), or a `ghost` nobody has. */
export type SeriesEntry =
  | (EntryFields & { kind: 'owned' | 'elsewhere'; copy: SeriesCopy })
  | (EntryFields & { kind: 'ghost'; copy?: undefined });

/** The saved progress the model reads (the server rows of `useAllProgressAll`). */
export type ProgressLike = Pick<Progress, 'position' | 'duration' | 'finished' | 'updated_at'>;
export type ProgressLookup = (
  connectionId: string,
  libraryId: number,
  path: string,
) => ProgressLike | undefined;

/** A book on another connection, as search returns it tagged with its source. */
export type ElsewhereBook = Book & { connectionId: string; connectionName: string };

/** A series position as a number ("2.5" -> 2.5, "1-3" -> 1), or undefined when it does
 * not parse. (The same rule as the book page's `seriesPositionValue`; that module is a
 * screen, so this pure one keeps its own copy.) */
function positionNumber(position: string | undefined): number | undefined {
  const n = parseFloat(position ?? '');
  return Number.isFinite(n) ? n : undefined;
}

/** A local `series_index` as a position label ("3", "3.5"), '' when unset (0). */
function indexLabel(index: number): string {
  return index > 0 ? String(index) : '';
}

/** Titles and names compared loosely: case, accents, punctuation and spacing ignored. */
export function looseKey(s: string | undefined): string {
  return foldAccents(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function yearOf(published: string | undefined): string | undefined {
  return /^\d{4}/.exec(published ?? '')?.[0];
}

function progressFields(
  copy: SeriesCopy,
  progressOf: ProgressLookup,
): Pick<EntryFields, 'fraction' | 'started' | 'finished' | 'updatedAt'> {
  const p = progressOf(copy.connectionId, copy.libraryId, copy.path);
  if (!p) return { fraction: 0, started: false, finished: false };
  const total = p.duration > 0 ? p.duration : (copy.book?.duration ?? 0);
  const fraction = p.finished ? 1 : progressFractionRemaining(p.position, total).fraction;
  return { fraction, started: p.position > 0, finished: p.finished, updatedAt: p.updated_at };
}

function copyFields(copy: SeriesCopy): Partial<EntryFields> {
  const b = copy.book;
  if (!b) return {};
  return {
    seconds: b.duration > 0 ? b.duration : undefined,
    year: yearOf(b.published),
    narrator: b.narrator || undefined,
    coverColor: b.cover_color,
    coverVersion: b.cover_version,
  };
}

function bookCopy(book: Book, connectionId: string, connectionName: string): SeriesCopy {
  return { connectionId, connectionName, libraryId: book.library_id, path: book.rel_path, book };
}

/** Sort a series' own books: by `series_index`, unnumbered (0) last, then by title. */
export function sortSeriesBooks(books: readonly Book[]): Book[] {
  return [...books].sort((a, b) => {
    const ia = a.series_index > 0 ? a.series_index : Infinity;
    const ib = b.series_index > 0 ? b.series_index : Infinity;
    if (ia !== ib) return ia - ib;
    return a.title.localeCompare(b.title);
  });
}

/** Past this many numbered places a gap-filled shelf would be mostly ghosts; gaps are
 * then not drawn (an owned "book 400" doesn't conjure 399 ghosts). */
const MAX_LOCAL_GAPS = 60;

/** The whole numbers missing below the highest owned position: 1, 2 and 4 owned means
 * book 3 is missing. Fractional positions (3.5) never make gaps of their own. */
export function localGaps(positions: readonly number[]): number[] {
  const have = new Set(positions.filter((p) => p > 0 && Number.isInteger(p)));
  const top = Math.floor(Math.max(0, ...positions));
  const gaps: number[] = [];
  for (let n = 1; n <= top; n++) if (!have.has(n)) gaps.push(n);
  return gaps.length > MAX_LOCAL_GAPS ? [] : gaps;
}

type Source = {
  /** The page's connection and its name. */
  connectionId: string;
  connectionName: string;
  progressOf: ProgressLookup;
  /** Books in this series on the listener's OTHER connections. */
  elsewhere?: readonly ElsewhereBook[];
};

/** An entry with a copy: its facts and the listener's progress in it. */
function copyEntry(
  kind: 'owned' | 'elsewhere',
  fields: Pick<EntryFields, 'key' | 'position' | 'title' | 'workId' | 'webUrl'>,
  copy: SeriesCopy,
  progressOf: ProgressLookup,
): SeriesEntry {
  return { ...fields, kind, copy, ...copyFields(copy), ...progressFields(copy, progressOf) };
}

/** Puts `entry` before the first entry numbered past `n` (an unnumbered one counts as
 * `unnumbered`), or at the end. */
function insertByPosition(out: SeriesEntry[], entry: SeriesEntry, n: number, unnumbered: number) {
  const at = out.findIndex((e) => (positionNumber(e.position) ?? unnumbered) > n);
  if (at === -1) out.push(entry);
  else out.splice(at, 0, entry);
}

function elsewhereEntry(
  fields: Pick<EntryFields, 'key' | 'position' | 'workId' | 'webUrl'>,
  match: ElsewhereBook,
  progressOf: ProgressLookup,
): SeriesEntry {
  const copy = bookCopy(match, match.connectionId, match.connectionName);
  return copyEntry('elsewhere', { ...fields, title: match.title }, copy, progressOf);
}

/** An owned book by its own `series_index`. */
function ownedBookEntry(b: Book, src: Source): SeriesEntry {
  const copy = bookCopy(b, src.connectionId, src.connectionName);
  return copyEntry(
    'owned',
    {
      key: `b:${contentKey(src.connectionId, b.library_id, b.rel_path)}`,
      position: indexLabel(b.series_index),
      title: b.title,
    },
    copy,
    src.progressOf,
  );
}

/**
 * The page with no community rail: the owned books by `series_index`, with a dashed
 * "Book N" ghost for each whole-number gap (or, when another server has that number of
 * the same series, its copy there).
 */
export function localEntries(books: readonly Book[], src: Source): SeriesEntry[] {
  const out = sortSeriesBooks(books).map((b) => ownedBookEntry(b, src));
  for (const n of localGaps(books.map((b) => b.series_index))) {
    const match = src.elsewhere?.find((b) => b.series_index === n);
    const fields = { key: `g:${n}`, position: String(n) };
    const entry: SeriesEntry = match
      ? elsewhereEntry(fields, match, src.progressOf)
      : { ...fields, kind: 'ghost', ...NOTHING };
    insertByPosition(out, entry, n, Infinity);
  }
  return out;
}

const NOTHING = { fraction: 0, started: false, finished: false } as const;

function sameAuthor(work: BookMetaSeriesWork, book: Book): boolean {
  const names = work.authors.map((a) => looseKey(a.name)).filter(Boolean);
  const author = looseKey(book.author);
  // Either side unknown: the title alone decides.
  if (names.length === 0 || !author) return true;
  return names.some((n) => author.includes(n) || n.includes(author));
}

/**
 * The page with a community rail: the shown reading order's works, each matched to the
 * listener's copy - by the server's placement (`local`) first, else by title among the
 * series' own books (a series named unlike the rail is not placed by the server) - then
 * to a copy on another server by title and author, else a ghost. Owned books the rail
 * doesn't list keep their place by `series_index` among the numbered entries (unnumbered
 * ones go last), so nothing the listener owns ever disappears from the page.
 * `extraBooks` are the rows of placed books from OTHER libraries.
 */
export function railEntries(
  view: SeriesView,
  books: readonly Book[],
  src: Source & { extraBooks?: readonly Book[] },
): SeriesEntry[] {
  const byKey = new Map<string, Book>();
  for (const b of [...books, ...(src.extraBooks ?? [])]) {
    byKey.set(contentKey(src.connectionId, b.library_id, b.rel_path), b);
  }
  const used = new Set<string>();
  const out: SeriesEntry[] = [];
  for (const w of view.works) {
    let copy: SeriesCopy | undefined;
    if (w.local) {
      const k = contentKey(src.connectionId, w.local.library_id, w.local.path);
      copy = {
        connectionId: src.connectionId,
        connectionName: src.connectionName,
        libraryId: w.local.library_id,
        path: w.local.path,
        book: byKey.get(k),
      };
      used.add(k);
    } else {
      const title = looseKey(w.title);
      const b = books.find(
        (x) =>
          !used.has(contentKey(src.connectionId, x.library_id, x.rel_path)) &&
          looseKey(x.title) === title,
      );
      if (b) {
        copy = bookCopy(b, src.connectionId, src.connectionName);
        used.add(contentKey(src.connectionId, b.library_id, b.rel_path));
      }
    }
    const base = { key: `w:${w.id}`, position: w.position ?? '', workId: w.id, webUrl: w.web_url };
    if (copy) {
      out.push(
        copyEntry('owned', { ...base, title: copy.book?.title || w.title }, copy, src.progressOf),
      );
      continue;
    }
    const title = looseKey(w.title);
    const match = src.elsewhere?.find((b) => looseKey(b.title) === title && sameAuthor(w, b));
    if (match) {
      out.push(elsewhereEntry(base, match, src.progressOf));
    } else {
      out.push({ ...base, kind: 'ghost', title: w.title, ...NOTHING });
    }
  }
  for (const b of sortSeriesBooks(books)) {
    if (used.has(contentKey(src.connectionId, b.library_id, b.rel_path))) continue;
    const entry = ownedBookEntry(b, src);
    if (b.series_index > 0) insertByPosition(out, entry, b.series_index, -Infinity);
    else out.push(entry);
  }
  return out;
}

/** The book the listener is on: the started, unfinished entry they played last. */
export function currentEntry(entries: readonly SeriesEntry[]): SeriesEntry | undefined {
  let best: SeriesEntry | undefined;
  for (const e of entries) {
    if (e.kind === 'ghost' || !e.started || e.finished) continue;
    if (!best || (e.updatedAt ?? '') > (best.updatedAt ?? '')) best = e;
  }
  return best;
}

/** The entry taken off the shelf when the page opens: the book you're on, else the
 * first unfinished one you own, else the first. */
export function defaultSelection(entries: readonly SeriesEntry[]): SeriesEntry | undefined {
  return (
    currentEntry(entries) ?? entries.find((e) => e.kind === 'owned' && !e.finished) ?? entries[0]
  );
}

export type SeriesStats = {
  entries: number;
  owned: number;
  elsewhere: number;
  missing: number;
  finished: number;
  /** Seconds of every entry with a known length (copies on the listener's servers). */
  seconds: number;
  /** Unlistened seconds of those copies. */
  aheadSeconds: number;
};

export function seriesStats(entries: readonly SeriesEntry[]): SeriesStats {
  const s: SeriesStats = {
    entries: entries.length,
    owned: 0,
    elsewhere: 0,
    missing: 0,
    finished: 0,
    seconds: 0,
    aheadSeconds: 0,
  };
  for (const e of entries) {
    if (e.kind === 'owned') s.owned++;
    else if (e.kind === 'elsewhere') s.elsewhere++;
    else s.missing++;
    if (e.finished) s.finished++;
    if (e.seconds) {
      s.seconds += e.seconds;
      if (!e.finished) s.aheadSeconds += e.seconds * (1 - e.fraction);
    }
  }
  return s;
}

/** The median known length, the stand-in width for entries of unknown length. */
export function typicalSeconds(entries: readonly SeriesEntry[]): number | undefined {
  const known = entries
    .map((e) => e.seconds)
    .filter((s): s is number => !!s)
    .sort((a, b) => a - b);
  return known.length ? known[Math.floor(known.length / 2)] : undefined;
}

export type TrackSegment = {
  key: string;
  /** Relative width: the square root of the length, like the spines. */
  flex: number;
  state: 'finished' | 'partial' | 'unread' | 'missing';
  fraction: number;
};

/** The segmented progress track: one segment per entry, green finished, pink partial,
 * hatched missing (a ghost). */
export function trackSegments(entries: readonly SeriesEntry[]): TrackSegment[] {
  const fallback = typicalSeconds(entries) ?? 36_000;
  return entries.map((e) => ({
    key: e.key,
    flex: Math.sqrt((e.seconds ?? fallback) / 60),
    state:
      e.kind === 'ghost'
        ? 'missing'
        : e.finished
          ? 'finished'
          : e.fraction > 0
            ? 'partial'
            : 'unread',
    fraction: e.fraction,
  }));
}

/**
 * The rail to show for a local series out of a book's rails: the one holding `workId`
 * when the link names a work; else the one named like the series (any of its reading
 * orders); else the one that places the most of the series' own books (`ownedKeys`,
 * `contentKey`s on `connectionId`). Undefined when none relates to the series.
 */
export function pickRail(
  rails: readonly BookMetaSeries[] | undefined,
  opts: { name?: string; workId?: string; connectionId: string; ownedKeys: ReadonlySet<string> },
): BookMetaSeries | undefined {
  if (!rails?.length) return undefined;
  const views = (s: BookMetaSeries) => [
    { name: s.name, works: s.works },
    ...(s.orderings ?? []).map((o) => ({ name: o.name, works: o.works ?? [] })),
  ];
  if (opts.workId) {
    const holding = rails.find((s) =>
      views(s).some((v) => v.works.some((w) => w.id === opts.workId)),
    );
    if (holding) return holding;
  }
  const name = looseKey(opts.name);
  if (name) {
    const named = rails.find((s) => views(s).some((v) => looseKey(v.name) === name));
    if (named) return named;
  }
  let best: { rail: BookMetaSeries; placed: number } | undefined;
  for (const s of rails) {
    const placed = s.works.filter(
      (w) =>
        w.local &&
        opts.ownedKeys.has(contentKey(opts.connectionId, w.local.library_id, w.local.path)),
    ).length;
    if (placed > 0 && (!best || placed > best.placed)) best = { rail: s, placed };
  }
  return best?.rail;
}

/**
 * Which of the series' books to ask the server's metadata about (it matches a book by
 * its ASIN or ISBN, so books without either are skipped): the one the listener is on
 * first, then by series order.
 */
export function metadataAnchor(
  books: readonly Book[],
  connectionId: string,
  progressOf: ProgressLookup,
): Book | undefined {
  const tagged = sortSeriesBooks(books).filter((b) => b.asin || b.isbn);
  let current: { book: Book; at: string } | undefined;
  for (const b of tagged) {
    const p = progressOf(connectionId, b.library_id, b.rel_path);
    if (p && isInProgress(p) && (!current || p.updated_at > current.at)) {
      current = { book: b, at: p.updated_at };
    }
  }
  return current?.book ?? tagged[0];
}
