import type { Book, BookRef, Capabilities, FsEntry, NextBook, QueueEntry } from '@/api/types';
import { bookTitle } from '@/lib/paths';

// What plays after a finished book: ONE answer for every end-of-book surface (the end
// credits' Play now and countdown, the background auto-play in `BookEndedListener`).
// Framework-free and it must NOT import the playback store; the server reads it does are
// injected (`UpNextSources`, see `up-next-sources.ts` for the real ones), so every rule
// here is tested without a server. In order:
//   (a) the head of the finished book's server's Up next queue (`queue`), skipping the
//       finished book itself, entries the server could not index (no `book`) and books
//       already finished;
//   (b) else the server's own answer (`next_book`: community order, then series, then
//       folder); a community work it could not place (`work` without `local`) is never
//       played, only reported (`unplaced`) so the credits can show it as a ghost;
//   (c) else, on a server without `next_book` (or when asking it failed), the folder's
//       next sibling (`resolveNextBook`, the behaviour before the server could answer).
// Keep-ahead's plan (`keep-ahead-controller.ts`) orders the books ahead the same way
// (the queue first, then the `next_book` chain, else the folder), so the book kept ready
// is the book that plays.

/** Why a book plays next: the listener queued it, it continues the series, or it is the
 * next one in the folder. */
export type UpNextSource = 'queue' | 'series' | 'folder';

/** The book to play after a finished one, on the finished book's own connection. */
export type UpNextBook = {
  connectionId: string;
  /** Its own library: a community answer can be in another library than the finished
   * book's. */
  libraryId: number;
  path: string;
  title: string;
  author: string;
  /** Seconds, 0 when unknown. */
  duration: number;
  /** The indexed book in the list shape, when the server has it. */
  book?: Book;
  source: UpNextSource;
  /** The series and the book's place in it, when known. */
  series?: { name: string; position?: string };
  /** The Up next entry it came from, by its own stored path (removes are exact): take it
   * off the queue once it plays. */
  queueEntry?: BookRef;
};

/** The community's next work that this server could not place: shown as "not on this
 * server", never played. */
export type UnplacedWork = { title: string; position: string; webUrl: string };

export type UpNextAnswer = { next: UpNextBook | null; unplaced?: UnplacedWork };

/** The server reads the resolver needs. Each may reject; the resolver then moves on. */
export type UpNextSources = {
  /** The server's flags (undefined when not known). */
  capabilities: () => Promise<Capabilities | undefined>;
  /** The Up next queue, in order. Asked only with `queue`. */
  queue: () => Promise<readonly QueueEntry[]>;
  /** `finishedKey`s of the books the listener has finished on this server. */
  finished: () => Promise<ReadonlySet<string>>;
  /** `GET /libraries/{id}/next`. Asked only with `next_book`. */
  nextBook: (libraryId: number, path: string) => Promise<NextBook>;
  /** The folder's next sibling (`resolveNextBook`), null when none. */
  folderNext: (libraryId: number, path: string) => Promise<FsEntry | null>;
};

/** The key `UpNextSources.finished` holds for a book. */
export function finishedKey(libraryId: number, path: string): string {
  return `${libraryId}:${path}`;
}

/** Whether a stored list entry holds the book at (libraryId, path). An add resolves a
 * part/disc path to its book, so the entry may be the book folder above the path. */
export function entryHolds(entry: BookRef, libraryId: number, path: string): boolean {
  return (
    entry.library_id === libraryId && (entry.path === path || path.startsWith(`${entry.path}/`))
  );
}

/** A series position as shown ("3", "2.5"), or undefined when the book has none. */
function seriesPosition(index: number | undefined): string | undefined {
  return index && index > 0 ? String(index) : undefined;
}

function seriesOf(name: string | undefined, position: string | undefined) {
  return name ? { name, position } : undefined;
}

/** The first queue entry that can play after `finished`: indexed, not the finished
 * book, not already finished. */
export function pickQueueHead(
  queue: readonly QueueEntry[],
  finished: { libraryId: number; path: string },
  finishedKeys: ReadonlySet<string>,
): QueueEntry | undefined {
  return queue.find(
    (e) =>
      !!e.book &&
      !entryHolds(e, finished.libraryId, finished.path) &&
      !finishedKeys.has(finishedKey(e.library_id, e.path)),
  );
}

function fromQueue(connectionId: string, entry: QueueEntry): UpNextBook {
  const book = entry.book;
  return {
    connectionId,
    libraryId: entry.library_id,
    path: entry.path,
    title: bookTitle(book?.title, entry.path),
    author: book?.author ?? '',
    duration: book?.duration ?? 0,
    book,
    source: 'queue',
    series: seriesOf(book?.series, seriesPosition(book?.series_index)),
    queueEntry: { library_id: entry.library_id, path: entry.path },
  };
}

function fromServer(connectionId: string, answer: NextBook): UpNextAnswer {
  const work = answer.work;
  const unplaced =
    work && !work.local
      ? { title: work.title, position: work.position, webUrl: work.web_url }
      : undefined;
  const next = answer.next;
  if (!next) return { next: null, unplaced };
  const book = answer.book;
  // A community answer names its place on the rail; a local series one its index.
  const position =
    answer.source === 'community' && work?.local
      ? work.position || seriesPosition(book?.series_index)
      : seriesPosition(book?.series_index);
  return {
    next: {
      connectionId,
      libraryId: next.library_id,
      path: next.path,
      title: bookTitle(book?.title, next.path),
      author: book?.author ?? '',
      duration: book?.duration ?? 0,
      book,
      source: answer.source === 'folder' ? 'folder' : 'series',
      series: seriesOf(book?.series, position),
    },
    unplaced,
  };
}

function fromFolder(connectionId: string, libraryId: number, entry: FsEntry): UpNextBook {
  return {
    connectionId,
    libraryId,
    path: entry.path,
    title: entry.title || entry.name,
    author: entry.author ?? '',
    duration: entry.duration ?? 0,
    source: 'folder',
    series: seriesOf(entry.series, seriesPosition(entry.series_index)),
  };
}

/** What plays after the book at (libraryId, path) on `connectionId` (see the module
 * comment for the order). Never rejects: a source that fails is skipped. */
export async function resolveUpNext(
  sources: UpNextSources,
  finished: { connectionId: string; libraryId: number; path: string },
): Promise<UpNextAnswer> {
  const { connectionId, libraryId, path } = finished;
  const caps = await sources.capabilities().catch(() => undefined);

  if (caps?.queue) {
    try {
      const [queue, done] = await Promise.all([
        sources.queue(),
        sources.finished().catch(() => new Set<string>()),
      ]);
      const head = pickQueueHead(queue, { libraryId, path }, done);
      if (head) return { next: fromQueue(connectionId, head) };
    } catch {
      // The queue could not be read: the series answers instead.
    }
  }

  if (caps?.next_book) {
    try {
      // The server already walked series and folder: its "nothing follows" stands.
      return fromServer(connectionId, await sources.nextBook(libraryId, path));
    } catch {
      // Not answered (an outage, a timeout): the folder answers instead.
    }
  }

  const sibling = await sources.folderNext(libraryId, path).catch(() => null);
  return { next: sibling ? fromFolder(connectionId, libraryId, sibling) : null };
}
