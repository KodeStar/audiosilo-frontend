import type { ApiClient } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import type { FsEntry } from '@/api/types';
import { downloadKey, useDownloads } from '@/downloads/store';
import { canAutoDownload } from '@/lib/network';
import { parentPath, pathLeaf } from '@/lib/paths';
import { useSettings } from '@/stores/settings';

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

/**
 * Prefetch the next book in the series when the current one nears its end. Honours the
 * `autoDownloadNext` preference and the network policy (`canAutoDownload`), and skips a
 * book that is already downloaded or queued. Best-effort and fully guarded: any failure is
 * swallowed and it never touches playback.
 */
export async function maybeAutoDownloadNext(
  connectionId: string,
  libraryId: number,
  currentPath: string,
): Promise<void> {
  try {
    const mode = useSettings.getState().autoDownloadNext;
    if (mode === 'never') return;

    const client = resolveClient(connectionId);
    if (!client) return;

    const next = await resolveNextBook(client, libraryId, currentPath);
    if (!next) return;

    // Already downloaded/queued/downloading? Nothing to do (only re-attempt an errored one,
    // matching the downloads store's own guard).
    const existing =
      useDownloads.getState().entries[downloadKey(connectionId, libraryId, next.path)];
    if (existing && existing.status !== 'error') return;

    if (!(await canAutoDownload(mode))) return;

    // Resolve the sibling to a full Book (+ chapters) so the offline copy is complete;
    // `item` indexes an unscanned folder on demand server-side.
    const book = await client.item(libraryId, next.path);
    const chapters = await client.chapters(libraryId, next.path);
    useDownloads.getState().download(connectionId, libraryId, book, chapters);
  } catch (err) {
    console.warn('[next-book] auto-download failed', err);
  }
}
