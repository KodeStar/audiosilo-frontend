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
 * The next sibling book after `currentPath` within a listing, or null if the current
 * book is the last. Candidates are the other entries that are a book or a directory
 * (an unindexed sibling book folder is `is_dir: true, is_book: false` - it must still
 * count); plain non-audio files (`.jpg`/`.nfo`) and loose non-book files are ignored.
 * The first candidate whose name sorts strictly after the current book's leaf name wins.
 */
export function findNextSibling(entries: FsEntry[], currentPath: string): FsEntry | null {
  const leaf = pathLeaf(currentPath);
  const candidates = entries
    .filter((e) => e.path !== currentPath && (e.is_book || e.is_dir))
    .sort((a, b) => naturalCompare(a.name, b.name));
  for (const c of candidates) {
    if (naturalCompare(c.name, leaf) > 0) return c;
  }
  return null;
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
