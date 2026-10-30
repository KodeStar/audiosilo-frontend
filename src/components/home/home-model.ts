import type { Href } from 'expo-router';

import type { LibrariesOfServer, SourcedProgress } from '@/api/hooks';
import type { Book, BookMetaSeriesWork, Library, NextBook } from '@/api/types';
import { lengthBucket, libraryBooksHref } from '@/components/library/books/books-view';
import { contentKeyOf } from '@/lib/content-key';
import type { MergedBook } from '@/lib/dedup';
import { podcastLibraryIds } from '@/lib/library-kind';
import { bookTitle, pathLeaf } from '@/lib/paths';
import { isInProgress, percentHeard } from '@/lib/progress-view';

import { NOW_CARD_WIDE_MIN } from './now-card-model';

/**
 * Home's rules (STYLEGUIDE section 2, Home): which book leads, what each shelf holds,
 * why a next book is suggested and where the links go. Pure and framework-free, so
 * the screen only lays them out.
 */

/** This week's width beside the Now card, and the gap between them. */
const THIS_WEEK_BESIDE = 300 + 20;

/** Whether This week fits beside the Now card in a page column `width` wide (0: not
 * measured yet, assume it does): the card must keep room for its cover beside its text.
 * The column, not the window: the Up next drawer takes up to 480 of a desktop. */
export function heroBeside(width: number): boolean {
  return width === 0 || width >= NOW_CARD_WIDE_MIN + THIS_WEEK_BESIDE;
}

/** A book by where it lives. */
export type BookAt = { connectionId: string; libraryId: number; path: string };

export const progressAt = (p: SourcedProgress): BookAt => ({
  connectionId: p.connectionId,
  libraryId: p.library_id,
  path: p.path,
});

/** One server's library list as Home reads it (`useLibrariesAll`'s groups). */
type LibraryGroupLike = Pick<LibrariesOfServer, 'connectionId' | 'status'> & {
  /** Absent: not paused. */
  paused?: boolean;
  libraries: readonly Pick<Library, 'id' | 'kind'>[];
};

/**
 * Whether a row is a book, not a podcast episode (Bridge Phase 2d-1): Home's book shelves
 * (Next in your series and what it asks `/next` about, the smart shelves, Recently
 * finished) hold books only. Progress carries no `episode`, so a row is told by its
 * library's kind. While a server's list is loading its rows are not yet known to be
 * books (no `/next` is asked for an episode meanwhile): `pending` says so, so a shelf can
 * hold its place with a skeleton rather than vanish and come back. A server whose list
 * failed is read as books (an older server has no podcast libraries), and so is one whose
 * list waits for the network (`paused`: the device went offline before it answered),
 * so Home shows what it has instead of skeletons for good (fe#155).
 */
export function bookRowTest(groups: readonly LibraryGroupLike[]): {
  isBook: (at: BookAt) => boolean;
  pending: (at: BookAt) => boolean;
} {
  const podcasts = new Map<string, Set<number> | null>();
  for (const g of groups) {
    podcasts.set(
      g.connectionId,
      g.status === 'loading' && !g.paused ? null : podcastLibraryIds(g.libraries),
    );
  }
  return {
    isBook: (at) => {
      const libs = podcasts.get(at.connectionId);
      return !!libs && !libs.has(at.libraryId);
    },
    pending: (at) => podcasts.get(at.connectionId) === null,
  };
}

/** The listener's books by state, most recently played first. */
export function splitProgress(progress: readonly SourcedProgress[]): {
  inProgress: SourcedProgress[];
  finished: SourcedProgress[];
} {
  const sorted = [...progress].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { inProgress: sorted.filter(isInProgress), finished: sorted.filter((p) => p.finished) };
}

/** The Now card's book: the one loaded in the player, else the most recently played
 * book in progress that can play here (`playable`; offline, a downloaded one), else the
 * most recently played, else none (the card's empty state). */
export function pickNowBook(
  loaded: BookAt | null,
  inProgress: readonly SourcedProgress[],
  playable?: (at: BookAt) => boolean,
) {
  if (loaded) return loaded;
  // Offline, the newest book that can play here (a downloaded one) leads, rather than a
  // newer one whose Resume would go nowhere (v2.5.1 PLAYER-02); none: the newest still.
  const lead = playable ? inProgress.find((p) => playable(progressAt(p))) : undefined;
  const first = lead ?? inProgress[0];
  return first ? progressAt(first) : null;
}

/** Whether a book can start here now: the device is online and the book's server isn't
 * known to be down (`online`, the reachability flags), or the book is downloaded. */
export function playableHere(
  at: BookAt,
  {
    deviceOnline,
    online,
    downloaded,
  }: {
    deviceOnline: boolean;
    online: Readonly<Record<string, boolean>>;
    downloaded: (at: BookAt) => boolean;
  },
): boolean {
  return (deviceOnline && online[at.connectionId] !== false) || downloaded(at);
}

export type GreetingPart = 'morning' | 'afternoon' | 'evening';

/** The part of the day the greeting names, by the device's local hour. */
export function greetingPart(hour: number): GreetingPart {
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

export type SyncPill = { kind: 'local' } | { kind: 'synced'; at: string } | null;

/**
 * The greeting's sync pill, told as it is (STYLEGUIDE section 1.3): a save still waiting
 * in the offline queue, or the server holding the newest progress not answering, means
 * the place is only on this device; otherwise this device synced when it last read that
 * server's progress (`fetchedAt`), or when the newest save was made if that is later. The
 * newest save alone would read "synced 24 minutes ago" on a device that signed in
 * seconds ago (UPGRADE-05). Another server being down says nothing about where the place
 * is (its own pill names it). Nothing at all when there is no progress yet.
 */
export function syncPill(input: {
  online: Record<string, boolean>;
  pending: number;
  /** The newest saved progress: when, and on which connection. */
  newest: { at: string; connectionId: string } | undefined;
  /** When this device last read the newest progress's server (epoch ms; 0 when unknown). */
  fetchedAt?: number;
}): SyncPill {
  const { newest, fetchedAt = 0 } = input;
  if (input.pending > 0) return { kind: 'local' };
  if (!newest) return null;
  if (input.online[newest.connectionId] === false) return { kind: 'local' };
  const saved = Date.parse(newest.at);
  const at = fetchedAt > 0 && !(saved >= fetchedAt) ? new Date(fetchedAt).toISOString() : newest.at;
  return { kind: 'synced', at };
}

// --- Next in your series -----------------------------------------------------------

/** Why a next book is suggested, told from the book it follows. */
export type NextReason =
  | { kind: 'current' }
  | { kind: 'progress'; of: BookAt; percent: number }
  | { kind: 'finished'; of: BookAt; at: string };

/** A book whose next book Home asks the server for. */
export type NextCandidate = BookAt & { reason: NextReason };

/** How many books Home asks `/next` about (one request each). */
const NEXT_CANDIDATES = 6;
/** Of those, at most this many are books in progress (the rest recently finished). */
const NEXT_IN_PROGRESS = 4;

/**
 * The books to look past: the Now card's book, the other books in progress, then the
 * recently finished ones, newest first, `NEXT_CANDIDATES` at most.
 */
export function nextCandidates(
  now: BookAt | null,
  inProgress: readonly SourcedProgress[],
  finished: readonly SourcedProgress[],
): NextCandidate[] {
  const out: NextCandidate[] = [];
  const nowKey = now ? contentKeyOf(now) : null;
  if (now) out.push({ ...now, reason: { kind: 'current' } });
  for (const p of inProgress) {
    if (out.length >= NEXT_IN_PROGRESS) break;
    if (contentKeyOf(progressAt(p)) === nowKey) continue;
    const percent = percentHeard(p.position, p.duration, false);
    out.push({ ...progressAt(p), reason: { kind: 'progress', of: progressAt(p), percent } });
  }
  for (const p of finished) {
    if (out.length >= NEXT_CANDIDATES) break;
    if (contentKeyOf(progressAt(p)) === nowKey) continue;
    out.push({
      ...progressAt(p),
      reason: { kind: 'finished', of: progressAt(p), at: p.finished_at ?? p.updated_at },
    });
  }
  return out;
}

export type NextItem =
  | (BookAt & { kind: 'book'; key: string; book: Book; reason: NextReason })
  | {
      kind: 'ghost';
      key: string;
      /** The connection and library of the book it follows (the series page opens there). */
      connectionId: string;
      libraryId: number;
      work: BookMetaSeriesWork;
      reason: NextReason;
    };

/**
 * The Next in your series cards from each candidate's `/next` answer: an owned next
 * book (`next` + its list-shape `book`) as a book, else the community rail's next work
 * that this server couldn't place as a ghost (shown, never played). Books in `skip`
 * (already on Home: started, finished or on the Now card) are left out, and a book (or
 * work) two candidates lead to shows once, with the first candidate's reason.
 */
export function nextInSeriesItems(
  answers: readonly { candidate: NextCandidate; answer: NextBook | undefined }[],
  skip: ReadonlySet<string>,
): NextItem[] {
  const out: NextItem[] = [];
  const seen = new Set<string>();
  for (const { candidate, answer } of answers) {
    if (!answer) continue;
    if (answer.next && answer.book) {
      const at: BookAt = {
        connectionId: candidate.connectionId,
        libraryId: answer.next.library_id,
        path: answer.next.path,
      };
      const key = contentKeyOf(at);
      if (skip.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'book', key, ...at, book: answer.book, reason: candidate.reason });
    } else if (answer.work && !answer.work.local) {
      const key = `${candidate.connectionId}:work:${answer.work.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'ghost',
        key,
        connectionId: candidate.connectionId,
        libraryId: candidate.libraryId,
        work: answer.work,
        reason: candidate.reason,
      });
    }
  }
  return out;
}

// --- Smart shelves -----------------------------------------------------------------

const WEEK_MS = 7 * 86_400_000;
/** Covers fanned on a smart shelf card. */
const FAN = 3;

export type ShelfCover = BookAt & { title: string; author?: string; coverVersion?: string };

export type SmartShelf =
  | { id: 'progress'; count: number; covers: ShelfCover[] }
  | { id: 'short'; covers: ShelfCover[] }
  | {
      id: 'narrator';
      name: string;
      books: number;
      listened: number;
      connectionId: string;
      libraryId: number;
      covers: ShelfCover[];
    }
  | { id: 'added'; count: number; servers: number; covers: ShelfCover[] };

const bookCover = (b: Book & { connectionId: string }): ShelfCover => ({
  connectionId: b.connectionId,
  libraryId: b.library_id,
  path: b.rel_path,
  title: bookTitle(b.title, b.rel_path),
  author: b.author,
  coverVersion: b.cover_version,
});

/**
 * Saved filters that keep themselves up to date, from data Home already has: Finish
 * what you started (books in progress), Short listens (recently added books under five
 * hours: a sample, so it shows no count), <Narrator> reads (the listener's most-heard
 * narrator, with books of theirs from one library) and Added this week. A shelf with
 * nothing on it is left out, and a single shelf isn't worth a section: fewer than two
 * gives none.
 */
export function smartShelves(input: {
  inProgress: readonly SourcedProgress[];
  recent: readonly MergedBook[];
  narrator?: {
    name: string;
    books: number;
    listened: number;
    connectionId: string;
    libraryId: number;
    sample: readonly Book[];
  };
  now: number;
}): SmartShelf[] {
  const out: SmartShelf[] = [];
  if (input.inProgress.length > 0) {
    out.push({
      id: 'progress',
      count: input.inProgress.length,
      covers: input.inProgress
        .slice(0, FAN)
        .map((p) => ({ ...progressAt(p), title: pathLeaf(p.path) })),
    });
  }
  // "Short" as the Library's length filter reads it (`len=short`), which the shelf opens.
  const short = input.recent.filter((b) => b.duration > 0 && lengthBucket(b.duration) === 'short');
  if (short.length > 0) out.push({ id: 'short', covers: short.slice(0, FAN).map(bookCover) });
  const n = input.narrator;
  if (n && n.sample.length > 0) {
    out.push({
      id: 'narrator',
      name: n.name,
      books: n.books,
      listened: n.listened,
      connectionId: n.connectionId,
      libraryId: n.libraryId,
      covers: n.sample.slice(0, FAN).map((b) => bookCover({ ...b, connectionId: n.connectionId })),
    });
  }
  const added = input.recent.filter((b) => {
    const at = b.added_at ? Date.parse(b.added_at) : NaN;
    return !Number.isNaN(at) && input.now - at <= WEEK_MS;
  });
  if (added.length > 0) {
    out.push({
      id: 'added',
      count: added.length,
      servers: new Set(added.map((b) => b.connectionId)).size,
      covers: added.slice(0, FAN).map(bookCover),
    });
  }
  return out.length >= 2 ? out : [];
}

// --- Links ---------------------------------------------------------------------------

/** Where a smart shelf opens (the narrator's shelf opens their page, with useOpen()). */
export function smartShelfHref(shelf: Exclude<SmartShelf, { id: 'narrator' }>): Href {
  switch (shelf.id) {
    case 'progress':
      return libraryBooksHref({ status: 'progress' });
    case 'short':
      return libraryBooksHref({ len: 'short' });
    case 'added':
      return libraryBooksHref({ sort: 'recent' });
  }
}
