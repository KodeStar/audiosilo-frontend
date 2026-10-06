import type { Href } from 'expo-router';

import type { SourcedProgress } from '@/api/hooks';
import type { Book, BookMetaSeriesWork, NextBook } from '@/api/types';
import { lengthBucket, libraryBooksHref } from '@/components/library/books/books-view';
import { contentKeyOf } from '@/lib/content-key';
import type { MergedBook } from '@/lib/dedup';
import { bookTitle, pathLeaf } from '@/lib/paths';
import { isInProgress, percentHeard } from '@/lib/progress-view';

/**
 * Home's rules (STYLEGUIDE section 2, Home): which book leads, what each shelf holds,
 * why a next book is suggested and where the links go. Pure and framework-free, so
 * the screen only lays them out.
 */

/** A book by where it lives. */
export type BookAt = { connectionId: string; libraryId: number; path: string };

export const progressAt = (p: SourcedProgress): BookAt => ({
  connectionId: p.connectionId,
  libraryId: p.library_id,
  path: p.path,
});

/** The listener's books by state, most recently played first. */
export function splitProgress(progress: readonly SourcedProgress[]): {
  inProgress: SourcedProgress[];
  finished: SourcedProgress[];
} {
  const sorted = [...progress].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { inProgress: sorted.filter(isInProgress), finished: sorted.filter((p) => p.finished) };
}

/** The Now card's book: the one loaded in the player, else the most recently played
 * book in progress, else none (the card's empty state). */
export function pickNowBook(loaded: BookAt | null, inProgress: readonly SourcedProgress[]) {
  if (loaded) return loaded;
  return inProgress[0] ? progressAt(inProgress[0]) : null;
}

export type GreetingPart = 'morning' | 'afternoon' | 'evening';

/** The part of the day the greeting names, by the device's local hour. */
export function greetingPart(hour: number): GreetingPart {
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

export type SyncPill = { kind: 'local' } | { kind: 'synced'; at: string } | null;

/**
 * The greeting's sync pill, told as it is (STYLEGUIDE section 1.3): a save still waiting
 * in the offline queue, or a server that can't be reached, means the place is only on
 * this device; otherwise the newest progress any server holds is when it last synced.
 * Nothing at all when there is no progress yet.
 */
export function syncPill(input: {
  offline: boolean;
  pending: number;
  lastSaved: string | undefined;
}): SyncPill {
  if (input.pending > 0 || (input.offline && input.lastSaved)) return { kind: 'local' };
  return input.lastSaved ? { kind: 'synced', at: input.lastSaved } : null;
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
export const NEXT_CANDIDATES = 6;
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
