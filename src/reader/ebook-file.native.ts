import { Directory, File, Paths } from 'expo-file-system';
import { readAsStringAsync } from 'expo-file-system/legacy';

import { ApiError, type ApiClient } from '@/api/client';
import { classifyDownloadError } from '@/downloads/failure';
import { downloadedEntryOf } from '@/downloads/store';
import { pathSlug } from '@/lib/path-slug';

import type { ChunkReader } from './book-chunks';

/**
 * Where the app's reader finds a book's EPUB (Bridge Phase 3b-2): a local file it reads in
 * chunks (`book-chunks.ts`), since the reader WebView itself may read no file. The book's
 * download when it holds the EPUB (`manifest.ebookUri`, read offline, never fetched again),
 * else the reader's own cache file, fetched with the Authorization header (the route takes
 * no `?token=`) and kept until the server's ebook changes size.
 *
 * The cache: one folder per (connection, library, book) under the app's cache directory
 * (the system may clear it; the next open fetches again), holding `book.epub`. It goes
 * with its connection (`clearEbookCache`, on sign-out and on removing the connection).
 */

const ROOT = 'reader';
const FILE = 'book.epub';

function cacheDir(connectionId: string, libraryId: number, path: string): Directory {
  return new Directory(Paths.cache, ROOT, connectionId, String(libraryId), pathSlug(path));
}

/** A book's EPUB as a local file. */
export type LocalEbook = { uri: string; size: number; downloaded: boolean };

/** Whether a cached EPUB of `cached` bytes is the server's ebook of `wanted` bytes: a
 * changed size is a changed ebook (fetched again), and an empty file is never one. */
export function cacheUsable(cached: number | null | undefined, wanted: number): boolean {
  return typeof cached === 'number' && cached > 0 && cached === wanted;
}

function sizeOf(file: File): number {
  try {
    return file.exists ? (file.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * The book's EPUB on this device, fetching it into the cache when it is not there (or no
 * longer the server's size). Rejects with an `ApiError` carrying the server's status when it
 * refused (404: no ebook any more), else with the download's own error; an abort leaves no
 * partial file behind.
 */
export async function localEbook({
  api,
  connectionId,
  libraryId,
  path,
  size,
  signal,
}: {
  api: ApiClient;
  connectionId: string;
  libraryId: number;
  path: string;
  /** The server's `ebook.size`. */
  size: number;
  signal?: AbortSignal;
}): Promise<LocalEbook> {
  const saved = downloadedEntryOf({ connectionId, libraryId, path })?.manifest.ebookUri;
  if (saved) {
    const file = new File(saved);
    const bytes = sizeOf(file);
    if (bytes > 0) return { uri: file.uri, size: bytes, downloaded: true };
  }

  const dir = cacheDir(connectionId, libraryId, path);
  const file = new File(dir, FILE);
  if (cacheUsable(sizeOf(file), size)) return { uri: file.uri, size, downloaded: false };

  if (!dir.exists) dir.create({ intermediates: true });
  // Fetched beside it, then moved over it: a download cut short never leaves a file that
  // reads as the book.
  const part = new File(dir, `${FILE}.part`);
  if (part.exists) part.delete();
  const { url, headers } = api.ebookRequest(libraryId, path);
  try {
    await File.createDownloadTask(url, part, { headers, signal }).downloadAsync();
  } catch (e) {
    if (part.exists) part.delete();
    const failure = classifyDownloadError(e);
    if (failure.kind === 'server' && failure.status) {
      throw new ApiError(failure.status, 'The ebook could not be downloaded.');
    }
    throw e;
  }
  const got = sizeOf(part);
  if (got <= 0) {
    if (part.exists) part.delete();
    throw new Error('The ebook download was empty.');
  }
  if (file.exists) file.delete();
  await part.move(file);
  return { uri: file.uri, size: got, downloaded: false };
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
