import type { ApiClient } from '@/api/client';
import type { FsEntry } from '@/api/types';
import { parentPath, pathLeaf } from '@/lib/paths';

// Resolving "the next book in a series" for the end-of-book flow. Framework-free (no
// React), and it must NOT import the playback store (store.ts imports this) to avoid a
// cycle. "Next" is defined by the server's own /fs ordering: plain case-insensitive,
// numeric-aware sibling order (so "Book 2" precedes "Book 10"), scanning the entries that
// sort strictly after the current book's folder name.

/** Case-insensitive, numeric-aware string compare - matches the natural series order a
 * reader expects ("Book 2" before "Book 10"), unlike lexicographic sort. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * The next sibling book after `currentPath` within a listing, or null if the current book
 * is the last. Ordering is by folder name (numeric-aware) - deliberately NOT by the server's
 * `series_index`, which is derived from a leading number in the name and is 0/absent for the
 * many libraries that number folders differently ("SS01 - Title", title-only names, ...); a
 * partial index would skip a book whose index is missing.
 *
 * Among the siblings that sort strictly after the current book we PREFER the next entry the
 * index already knows is a playable book (`is_book`). We only fall back to a bare directory
 * (a not-yet-scanned book folder is `is_dir: true, is_book: false`) when NOTHING in the
 * folder is indexed yet - i.e. a freshly-added/large library mid-scan. Once the folder has
 * any indexed book, a remaining bare directory is almost certainly a non-book folder
 * (Bonus/artwork/author dir), so returning it would strand the player on an unplayable path;
 * we return null ("end of series") instead. Plain non-audio files and loose non-book files
 * are always ignored.
 */
export function findNextSibling(entries: FsEntry[], currentPath: string): FsEntry | null {
  const leaf = pathLeaf(currentPath);
  const after = entries
    .filter((e) => e.path !== currentPath && (e.is_book || e.is_dir))
    .filter((e) => naturalCompare(e.name, leaf) > 0)
    .sort((a, b) => naturalCompare(a.name, b.name));

  // Prefer the next entry the index already resolved to a playable book.
  const nextBook = after.find((e) => e.is_book);
  if (nextBook) return nextBook;

  // No indexed book follows. Fall back to the next directory ONLY when the folder is wholly
  // unindexed (mid-scan) - otherwise a trailing bare directory is a non-book folder we must
  // not offer as "next".
  if (entries.some((e) => e.is_book)) return null;
  return after.find((e) => e.is_dir) ?? null;
}

const PAGE_LIMIT = 200;

/**
 * Browse the current book's containing folder (paging to exhaustion) and return the next
 * sibling book, or null. Never throws - any failure (unreachable server, missing folder)
 * resolves to null so the caller degrades to "no next book".
 */
export async function resolveNextBook(
  client: ApiClient,
  libraryId: number,
  currentPath: string,
): Promise<FsEntry | null> {
  try {
    const parent = parentPath(currentPath);
    const entries: FsEntry[] = [];
    let offset = 0;
    // Page through the whole folder so a series longer than one page still resolves.
    for (;;) {
      const listing = await client.browse(libraryId, parent, offset, PAGE_LIMIT);
      entries.push(...listing.entries);
      if (listing.next_offset === undefined || listing.entries.length === 0) break;
      offset = listing.next_offset;
    }
    return findNextSibling(entries, currentPath);
  } catch {
    return null;
  }
}
