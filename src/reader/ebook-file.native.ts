import { Directory, File, Paths } from 'expo-file-system';
import { readAsStringAsync } from 'expo-file-system/legacy';

import { ApiError, type ApiClient } from '@/api/client';
import { classifyDownloadError } from '@/downloads/failure';
import { pathSlug } from '@/lib/path-slug';

import type { ChunkReader } from './book-chunks';

/**
 * Where the app's reader finds a book's EPUB (Bridge Phase 3b-2): a local file it reads in
 * chunks (`book-chunks.ts`), since the reader WebView itself may read no file. The book's
 * download when it holds the EPUB (`manifest.ebookUri`, read offline, never fetched again),
 * else the reader's own cache file, fetched with the Authorization header (the route takes
 * no `?token=`).
 *
 * The cache: one folder per (connection, library, book) under the app's cache directory
 * (the system may clear it; the next open fetches again), holding `book-<size>.epub`, named
 * by the server's `ebook.size` it was fetched for. That size is what the server's last scan
 * recorded, while the route serves the file as it is now, so the copy's own length can
 * differ: it is the book while it is there and not empty, and a new size (a scan saw the
 * ebook change) fetches it again and drops the old copy. It goes with its connection
 * (`clearEbookCache`, on sign-out and on removing the connection).
 */

const ROOT = 'reader';

function cacheDir(connectionId: string, libraryId: number, path: string): Directory {
  return new Directory(Paths.cache, ROOT, connectionId, String(libraryId), pathSlug(path));
}

/** The cache file of the book at the server's `ebook.size`. */
const cacheName = (size: number) => `book-${size}.epub`;

/** A book's EPUB as a local file. */
export type LocalEbook = { uri: string; size: number };

function sizeOf(file: File): number {
  try {
    return file.exists ? (file.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/** Deletes a file or folder when it is there. Best effort. */
function drop(entry: File | Directory): void {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // the system clears the cache directory in time anyway
  }
}

// The `.part` names of the fetches running now, in this process: the only parts a cleanup
// keeps. Numbered, so two opens of one book never share one.
const fetching = new Set<string>();
let parts = 0;

/** Drops a book folder's files but `keep` and the live parts: another size's copy, a part
 * a fetch the app did not live to finish left behind. Best effort. */
function dropOthers(dir: Directory, keep: string): void {
  try {
    for (const entry of dir.list()) {
      if (entry.name !== keep && !fetching.has(entry.name)) drop(entry);
    }
  } catch {
    // the next fetch tries again
  }
}

/**
 * The book's EPUB on this device: the download's copy (`saved`) when it is there, else the
 * cache file for the server's `size`, fetched when it is not there yet. Resolves with the
 * file's own length, the one the reader is sent. Rejects with an `ApiError` carrying the
 * server's status when it refused (404: no ebook any more), else with the download's own
 * error; a download that fails or is aborted leaves no partial file behind.
 */
export async function localEbook({
  api,
  connectionId,
  libraryId,
  path,
  size,
  saved,
  signal,
}: {
  api: ApiClient;
  connectionId: string;
  libraryId: number;
  path: string;
  /** The server's `ebook.size` (its last scan's): it names the cache file. */
  size: number;
  /** The book download's EPUB (its `manifest.ebookUri`), when it has one. */
  saved?: string;
  signal?: AbortSignal;
}): Promise<LocalEbook> {
  if (saved) {
    const file = new File(saved);
    const bytes = sizeOf(file);
    if (bytes > 0) return { uri: file.uri, size: bytes };
  }

  const dir = cacheDir(connectionId, libraryId, path);
  const file = new File(dir, cacheName(size));
  const cached = sizeOf(file);
  if (cached > 0) return { uri: file.uri, size: cached };

  if (!dir.exists) dir.create({ intermediates: true });
  // Fetched beside it, then moved over it: a download cut short never leaves a file that
  // reads as the book.
  const name = `${file.name}.${++parts}.part`;
  const part = new File(dir, name);
  const { url, headers } = api.ebookRequest(libraryId, path);
  fetching.add(name);
  let got: number;
  try {
    try {
      // iOS: a foreground session, which fails at once offline (and after 60 s without
      // data); the default background one waits days for a connection. Android ignores it.
      await File.createDownloadTask(url, part, {
        headers,
        signal,
        sessionType: 'foreground',
      }).downloadAsync();
      got = sizeOf(part);
      if (got <= 0) throw new Error('The ebook download was empty.');
    } catch (e) {
      drop(part);
      const failure = classifyDownloadError(e);
      if (failure.kind === 'server' && failure.status) {
        throw new ApiError(failure.status, 'The ebook could not be downloaded.');
      }
      throw e;
    }
    await part.move(file, { overwrite: true });
  } finally {
    // Deletes nothing: after the move, `part` is the book.
    fetching.delete(name);
  }
  dropOthers(dir, file.name);
  return { uri: file.uri, size: got };
}

/** Whether the book's EPUB is on this device without a fetch: the download's copy
 * (`saved`), or the cache file for the server's `size`. The offline place lookup asks it
 * (`lookupReadingPlace`). Never throws. */
export async function hasLocalEbook({
  connectionId,
  libraryId,
  path,
  size,
  saved,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  size?: number;
  saved?: string;
}): Promise<boolean> {
  try {
    if (saved && sizeOf(new File(saved)) > 0) return true;
    if (size === undefined) return false;
    return sizeOf(new File(cacheDir(connectionId, libraryId, path), cacheName(size))) > 0;
  } catch {
    return false;
  }
}

/** Reads a local EPUB's chunks as base64 (encoded natively, never in JS). */
export function chunkReader(uri: string): ChunkReader {
  return (position, length) => readAsStringAsync(uri, { encoding: 'base64', position, length });
}

/** Drop a connection's cached EPUBs (sign-out, removing the connection). Best effort. */
export async function clearEbookCache(connectionId: string): Promise<void> {
  try {
    const dir = new Directory(Paths.cache, ROOT, connectionId);
    if (dir.exists) dir.delete();
  } catch {
    // the system clears the cache directory in time anyway
  }
}
