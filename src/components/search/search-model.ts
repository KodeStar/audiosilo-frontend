import type {
  BookMetaAttribution,
  BookMetaCharacter,
  ChaptersResponse,
  PersonCount,
  Progress,
  SeriesCount,
} from '@/api/types';
import {
  chapterStartsOf,
  characterIsVisible,
  type ListeningProgress,
  listeningProgressFor,
} from '@/components/library/meta-gating';
import { contentKey } from '@/lib/content-key';
import { hashString } from '@/lib/monogram';
import { foldAccents } from '@/lib/names';
import { isInProgress } from '@/lib/progress-view';

/**
 * Search's model, shared by the Search screen and the web command palette (pure, so
 * both group, rank and gate the same way): what matches a query among the people and
 * series lists of every library on every server, and among the characters of the books
 * the listener has started, with the ones they have not reached yet counted, never
 * named.
 */

/** Case- and accent-insensitive form of a name or a query ("Émile" finds "emile"). */
export function fold(s: string): string {
  return foldAccents(s.toLocaleLowerCase());
}

/**
 * How well `text` matches a folded query: 0 = it starts with it, 1 = a word in it does,
 * 2 = it contains it somewhere, null = no match. Lower ranks sort first.
 */
export function matchRank(text: string, foldedQuery: string): 0 | 1 | 2 | null {
  if (!foldedQuery) return null;
  const t = fold(text);
  const i = t.indexOf(foldedQuery);
  if (i < 0) return null;
  if (i === 0) return 0;
  // A word start: anything after a non-letter/digit (space, hyphen, period...).
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(foldedQuery)}`, 'u').test(t) ? 1 : 2;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where a list came from: one library on one server. */
export type ListSource = { connectionId: string; connectionName: string; libraryId: number };

/** One library's browse list. */
export type SourcedList<T> = { source: ListSource; items: T[] };

/** A person or series that matched: the copy to open (`source`, the first server and
 * library in connection order) and every other library that has one of the same name. */
export type NamedHit<T> = T & { source: ListSource; also: ListSource[] };

export type PersonHit = NamedHit<PersonCount>;
export type SeriesHit = NamedHit<SeriesCount>;

/**
 * The entries of every list whose name matches `query`, one per name (folded: the same
 * author on two servers, or spelt with and without an accent, is one hit opening the
 * first copy), best match first, then the most books, then by name. `limit` caps the
 * hits; the caller reads the total from an uncapped call if it needs one.
 */
export function matchNamed<T extends { name: string; books: number }>(
  lists: readonly SourcedList<T>[],
  query: string,
  limit = Infinity,
): NamedHit<T>[] {
  const q = fold(query.trim());
  if (!q) return [];
  const byName = new Map<string, { hit: NamedHit<T>; rank: number }>();
  for (const { source, items } of lists) {
    for (const item of items) {
      if (!item.name) continue;
      const rank = matchRank(item.name, q);
      if (rank === null) continue;
      const key = fold(item.name);
      const seen = byName.get(key);
      if (seen) {
        if (
          !seen.hit.also.some((s) => sameLibrary(s, source)) &&
          !sameLibrary(seen.hit.source, source)
        ) {
          seen.hit.also.push(source);
        }
      } else {
        byName.set(key, { hit: { ...item, source, also: [] }, rank });
      }
    }
  }
  return [...byName.values()]
    .sort(
      (a, b) =>
        a.rank - b.rank || b.hit.books - a.hit.books || a.hit.name.localeCompare(b.hit.name),
    )
    .slice(0, limit)
    .map((e) => e.hit);
}

const sameLibrary = (a: ListSource, b: ListSource) =>
  a.connectionId === b.connectionId && a.libraryId === b.libraryId;

/** The other servers a hit is also on (by name, once each, never its own). */
export function alsoOnServers(hit: { source: ListSource; also: ListSource[] }): string[] {
  const names: string[] = [];
  for (const s of hit.also) {
    if (s.connectionId === hit.source.connectionId) continue;
    if (!names.includes(s.connectionName)) names.push(s.connectionName);
  }
  return names;
}

// --- Characters --------------------------------------------------------------

/** At most this many started books are checked for characters (one metadata request
 * each, plus their chapters while unfinished). */
export const MAX_CHARACTER_BOOKS = 8;

/** A saved place the character search reads, tagged with its server. */
export type ProgressRow = Pick<
  Progress,
  'library_id' | 'path' | 'position' | 'finished' | 'updated_at'
> & { connectionId: string };

/**
 * The books whose characters Search may name: the listener's in-progress and finished
 * books (an unstarted book has nobody "met"), newest first as given, on servers that
 * serve community metadata, once each, at most `MAX_CHARACTER_BOOKS`.
 */
export function characterBooksToLoad<P extends ProgressRow>(
  progress: readonly P[],
  hasMetadata: (connectionId: string) => boolean,
  max = MAX_CHARACTER_BOOKS,
): P[] {
  const seen = new Set<string>();
  const out: P[] = [];
  for (const p of progress) {
    if (out.length >= max) break;
    if (!(p.finished || isInProgress(p)) || !hasMetadata(p.connectionId)) continue;
    const key = contentKey(p.connectionId, p.library_id, p.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Where the listener is in a started book, for the character gate: the same rule as the
 * book page (`meta-gating`): ONE whole-book position (the player's live one when the
 * book is loaded and further on, else the saved one) mapped onto the book's own chapter
 * list. Until the chapters arrive (`chapters` undefined) an unfinished book counts as
 * not started, which only shows the cast from the start: a late chapter list can reveal
 * more, never less.
 */
export function listeningIn(input: {
  progress: Pick<Progress, 'position' | 'finished'>;
  chapters?: Pick<ChaptersResponse, 'chapters' | 'files'>;
  livePosition?: number;
}): ListeningProgress {
  const { progress, chapters, livePosition } = input;
  const saved = progress.position;
  return listeningProgressFor({
    chapterStarts: chapters ? chapterStartsOf(chapters.chapters, chapters.files) : [],
    position: chapters ? (livePosition !== undefined ? Math.max(livePosition, saved) : saved) : 0,
    finished: progress.finished,
  });
}

/** A started book's community characters and how far the listener is in it. */
export type CharacterBook = {
  connectionId: string;
  libraryId: number;
  path: string;
  /** The community work's title (what the character "is from"). */
  title: string;
  listening: ListeningProgress;
  characters: readonly BookMetaCharacter[];
  /** The server-written CC BY-SA credit for the book's community content. */
  attribution?: BookMetaAttribution;
};

/** A character the listener has met, and the book to open for it. */
export type CharacterHit = {
  key: string;
  name: string;
  role?: BookMetaCharacter['role'];
  bookTitle: string;
  connectionId: string;
  libraryId: number;
  path: string;
};

export type CharacterMatches = {
  /** Met characters matching the query (by name or alias), capped at `limit`. */
  hits: CharacterHit[];
  /** Every met match, before the cap. */
  total: number;
  /** Characters matching the query that the listener has NOT reached in any book: a
   * count only, never a name. A name met in one book is not counted again for
   * another book that has not reached it yet. */
  hidden: number;
  /** The credits of the books the hits come from, once each (render beside them). */
  attributions: BookMetaAttribution[];
};

/**
 * The characters matching `query` across the listener's started books, gated by their
 * own place in each book (`characterIsVisible`: finished = everyone, else up to their
 * chapter, at least the cast from the start). A met character shows once (the most
 * recently played book's entry), best name match first; the rest are only counted.
 */
export function matchCharacters(
  books: readonly CharacterBook[],
  query: string,
  limit = Infinity,
): CharacterMatches {
  const q = fold(query.trim());
  const empty: CharacterMatches = { hits: [], total: 0, hidden: 0, attributions: [] };
  if (!q) return empty;

  const met = new Map<
    string,
    { hit: CharacterHit; rank: number; attribution?: BookMetaAttribution }
  >();
  const unmet = new Set<string>();
  books.forEach((book) => {
    for (const c of book.characters) {
      if (!c.name) continue;
      const nameRank = matchRank(c.name, q);
      const aliasHit = nameRank === null && (c.aliases ?? []).some((a) => matchRank(a, q) !== null);
      if (nameRank === null && !aliasHit) continue;
      const name = fold(c.name);
      if (!characterIsVisible(c, book.listening)) {
        unmet.add(name);
        continue;
      }
      if (met.has(name)) continue;
      met.set(name, {
        hit: {
          key: `${contentKey(book.connectionId, book.libraryId, book.path)}#${c.id}`,
          name: c.name,
          role: c.role,
          bookTitle: book.title,
          connectionId: book.connectionId,
          libraryId: book.libraryId,
          path: book.path,
        },
        // An alias-only match ranks after every name match.
        rank: nameRank ?? 3,
        attribution: book.attribution,
      });
    }
  });

  const ordered = [...met.values()].sort((a, b) => a.rank - b.rank);
  const shown = ordered.slice(0, limit);
  const attributions: BookMetaAttribution[] = [];
  for (const { attribution } of shown) {
    if (!attribution) continue;
    if (
      attributions.some((a) => a.credit === attribution.credit && a.license === attribution.license)
    )
      continue;
    attributions.push(attribution);
  }
  let hidden = 0;
  for (const name of unmet) if (!met.has(name)) hidden++;
  return { hits: shown.map((e) => e.hit), total: ordered.length, hidden, attributions };
}

/** A stable hue slot (0-3) for a name: the character token's tint. */
export function hueSlot(name: string): number {
  return hashString(name) % 4;
}
