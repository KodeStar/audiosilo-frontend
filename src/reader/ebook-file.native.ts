import { Directory, File, Paths } from 'expo-file-system';
import { readAsStringAsync } from 'expo-file-system/legacy';

import { ApiError, type ApiClient, isSignedOutError } from '@/api/client';
import { engine } from '@/downloads/engine';
import { classifyDownloadError } from '@/downloads/failure';
import { nativeNumber } from '@/lib/native-number';
import { pathSlug } from '@/lib/path-slug';
import { expoCrypto, toHex } from '@/lib/random';
import { sha256 } from '@/lib/sha256';

import type { ChunkReader } from './book-chunks';
import { EbookStorageError, EbookTooLargeError, MAX_EBOOK_BYTES } from './ebook-errors';
import type { EbookFileRef } from './ebook-file';
import type { OpenedEbook } from './ebook-identity';

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
 * (`clearEbookCache`, on sign-out and on removing the connection), and the whole cache is
 * held to `MAX_EBOOK_BYTES`, so one book of the largest size the reader opens always fits:
 * after each fetch the copies opened longest ago go first (an open of a cached copy marks
 * its folder, `OPENED`), and a folder left empty goes with them.
 *
 * A book over `MAX_EBOOK_BYTES` (the server's size, the copy's own length) is refused as too
 * large before any fetch or transfer, and a fetch that finds no room (the cache's own copies
 * opened longest ago make room first, when dropping them can make enough), or a copy the
 * cache could not take, is a storage failure (`EbookStorageError`) that leaves no partial
 * file (fe#172).
 */

const ROOT = 'reader';

function cacheDir(connectionId: string, libraryId: number, path: string): Directory {
  return new Directory(Paths.cache, ROOT, connectionId, String(libraryId), pathSlug(path));
}

/** The cache file of the book at the server's `ebook.size`. */
const cacheName = (size: number) => `book-${size}.epub`;

/** A book folder's mark of its last open: its own modification time is when (fe#354). */
const OPENED = 'opened';

/** A book's EPUB as a local file. */
export type LocalEbook = { uri: string; size: number };

/** Identify the actual selected file. Reading a download that throws lets the host try
 * the server copy before it publishes any identity or transfers any chunks. */
export async function identifyEbook(
  file: LocalEbook,
  source: OpenedEbook['source'],
): Promise<OpenedEbook> {
  const bytes = await new File(file.uri).bytes();
  // expo-crypto's native digest, taken lazily (`expoCrypto`: this module is on the launch
  // path through the downloads store), else the pure-JS one.
  const native = expoCrypto();
  const hash = native
    ? new Uint8Array(await native.digest(native.CryptoDigestAlgorithm.SHA256, bytes))
    : sha256(bytes);
  return {
    source,
    size: bytes.byteLength,
    sha256: toHex(hash),
  };
}

function sizeOf(file: File): number {
  try {
    return file.exists ? nativeNumber(file.size) : 0;
  } catch {
    return 0;
  }
}

/** Refuses a book the reader can't take (`EbookTooLargeError`). */
function assertReadable(size: number): void {
  if (size > MAX_EBOOK_BYTES) throw new EbookTooLargeError(size);
}

const NO_ROOM = 'There is not enough space on this device for the ebook.';
const NOT_SAVED = 'The ebook could not be saved on this device.';

/** Deletes a file or folder when it is there. Best effort. */
function drop(entry: File | Directory): void {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // the system clears the cache directory in time anyway
  }
}

// The `.part` names of the fetches running now, in this process, with their book folders:
// the only parts a cleanup keeps, and folders it never drops. Numbered, so two opens of one
// book never share one.
const fetching = new Map<string, string>();
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
 * The error a download the server's address refused with `status` is. The download task
 * hands back the status alone, so a 401 can't be told from an auth proxy's own by the
 * server's mark or its body (`ApiError.fromProxy`, fe#295, WS-401-MARK): the server is asked
 * through the client (`me`), and only
 * its own refusal of the token reads as signed out (the client flags the connection, as for
 * any request). Anything else (the proxy turned that away too, the token was taken, no
 * answer) is no sign-out: the reader offers Try again, never "Sign in again".
 */
async function refusalOf(api: ApiClient, status: number): Promise<ApiError> {
  const message = 'The ebook could not be downloaded.';
  if (status !== 401) return new ApiError(status, message);
  const signedOut = await api.me().then(
    () => false,
    (e: unknown) => isSignedOutError(e),
  );
  return new ApiError(401, message, undefined, undefined, !signedOut);
}

/**
 * The book's EPUB on this device: the download's copy (`saved`) when it is there, else the
 * cache file for the server's `size`, fetched when it is not there yet. Resolves with the
 * file's own length, the one the reader is sent. Rejects with an `ApiError` carrying the
 * server's status when it refused (404: no ebook any more), `EbookTooLargeError` for a book
 * over the reader's size (before fetching it when the server's size says so),
 * `EbookStorageError` when the device has no room for it or the cache could not take it,
 * else with the download's own error; a download that fails or is aborted leaves no partial
 * file behind. `onFetch` is
 * called as a fetch starts (the book was not on the device), before any file of it is: a
 * copy fetched for this open is no sign the book was read here (fe#193).
 */
export async function localEbook({
  api,
  connectionId,
  libraryId,
  path,
  size,
  saved,
  signal,
  onFetch,
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
  onFetch?: () => void;
}): Promise<LocalEbook> {
  const here = existingEbook({ connectionId, libraryId, path, size, saved });
  if (here) {
    assertReadable(here.size);
    if (here.uri !== saved) void markOpened(cacheDir(connectionId, libraryId, path));
    return here;
  }
  // Too large for the reader, or for the room left: said before a byte is fetched. The
  // reader's own older copies make room first, when they can.
  assertReadable(size);
  const short = await shortOf(size);
  if (short > 0) {
    trimCache(undefined, short);
    if ((await shortOf(size)) > 0) throw new EbookStorageError(NO_ROOM);
  }
  onFetch?.();

  const dir = cacheDir(connectionId, libraryId, path);
  const file = new File(dir, cacheName(size));

  try {
    if (!dir.exists) dir.create({ intermediates: true });
  } catch (e) {
    throw new EbookStorageError(NOT_SAVED, { cause: e });
  }
  // Fetched beside it, then moved over it: a download cut short never leaves a file that
  // reads as the book.
  const name = `${file.name}.${++parts}.part`;
  const part = new File(dir, name);
  const { url, headers } = api.ebookRequest(libraryId, path);
  fetching.set(name, bare(dir.uri));
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
      if (failure.kind === 'server' && failure.status) throw await refusalOf(api, failure.status);
      if (failure.kind === 'storage') {
        throw new EbookStorageError(NO_ROOM, { cause: e });
      }
      throw e;
    }
    // Longer than the server's size said, past what the reader takes: not kept.
    if (got > MAX_EBOOK_BYTES) {
      drop(part);
      throw new EbookTooLargeError(got);
    }
    try {
      await part.move(file, { overwrite: true });
    } catch (e) {
      drop(part);
      throw new EbookStorageError(NOT_SAVED, { cause: e });
    }
  } finally {
    // Deletes nothing: after the move, `part` is the book.
    fetching.delete(name);
  }
  dropOthers(dir, file.name);
  trimCache(file.uri);
  return { uri: file.uri, size: got };
}

/** Marks a cached copy's book folder as opened now (`OPENED`), so the trim keeps the
 * books read lately over the ones fetched lately. Best effort: unmarked, the copy's own
 * fetch time stands. */
async function markOpened(dir: Directory): Promise<void> {
  try {
    await new File(dir, OPENED).write(String(Date.now()));
  } catch {
    // the trim goes by the fetch time instead
  }
}

/** When `file` was last written (0, first to go, when it can't say). */
function writtenAt(file: File): number {
  try {
    return nativeNumber(file.modificationTime ?? 0);
  } catch {
    return 0;
  }
}

/** A cached copy, with what the trim needs. */
type CachedCopy = { file: File; size: number; at: number };

/** Every cached EPUB under `dir`, its folders walked (connection, library, book), each at
 * its last open: its folder's `OPENED` mark, else when it was fetched. */
function cachedCopies(dir: Directory, into: CachedCopy[] = []): CachedCopy[] {
  const entries = dir.list();
  const mark = entries.find((e): e is File => e instanceof File && e.name === OPENED);
  const opened = mark ? writtenAt(mark) : 0;
  for (const entry of entries) {
    if (entry instanceof Directory) {
      cachedCopies(entry, into);
    } else if (entry !== mark && !fetching.has(entry.name)) {
      into.push({ file: entry, size: sizeOf(entry), at: Math.max(writtenAt(entry), opened) });
    }
  }
  return into;
}

/** A folder's uri without the trailing slash the native one carries. */
const bare = (uri: string) => uri.replace(/\/+$/, '');

/** Drops the folder at `uri` when it holds nothing but its `OPENED` mark, then its parents
 * the same way, up to (not) the cache's own folder `root`; never a folder a fetch is
 * writing into. Best effort. */
function dropEmptyFolders(uri: string, root: string): void {
  const live = [...fetching.values()];
  for (let at = uri; at.startsWith(`${root}/`); at = at.slice(0, at.lastIndexOf('/'))) {
    if (live.some((d) => d === at || d.startsWith(`${at}/`))) return;
    try {
      const dir = new Directory(at);
      if (dir.list().some((e) => e.name !== OPENED)) return;
      dir.delete();
    } catch {
      return;
    }
  }
}

/** How many bytes the device lacks for `size` more (0 when it has room, or can't say). */
async function shortOf(size: number): Promise<number> {
  const free = (await engine.storageEstimate().catch(() => null))?.free;
  return free === undefined ? 0 : Math.max(0, size - free);
}

/**
 * Holds the reader's cache, every connection's copies together, to `MAX_EBOOK_BYTES`, and
 * `room` bytes below what it holds (a fetch the device has no room for): the copies opened
 * longest ago go first, never `keep` (the copy this open fetched) or a part a fetch is
 * writing, and the folders they leave empty go with them. When dropping all it may would
 * still not get there, it drops none: a copy dropped for nothing is a fetch on its next
 * open. Best effort: a copy dropped is fetched again on its next open.
 */
function trimCache(keep?: string, room = 0): void {
  try {
    const root = new Directory(Paths.cache, ROOT);
    if (!root.exists) return;
    const copies = cachedCopies(root);
    let total = copies.reduce((sum, c) => sum + c.size, 0);
    const limit = Math.min(MAX_EBOOK_BYTES, total - room);
    const droppable = copies.filter((c) => c.file.uri !== keep).sort((a, b) => a.at - b.at);
    if (total - droppable.reduce((sum, c) => sum + c.size, 0) > limit) return;
    const left = new Set<string>();
    for (const copy of droppable) {
      if (total <= limit) break;
      drop(copy.file);
      total -= copy.size;
      left.add(copy.file.uri.slice(0, copy.file.uri.lastIndexOf('/')));
    }
    for (const folder of left) dropEmptyFolders(folder, bare(root.uri));
  } catch {
    // the system clears the cache directory in time anyway
  }
}

/** The book's EPUB already on this device, not empty: the download's copy (`saved`), else
 * the cache file for the server's `size`; null when neither is there. */
function existingEbook({
  connectionId,
  libraryId,
  path,
  size,
  saved,
}: EbookFileRef): LocalEbook | null {
  if (saved) {
    const file = new File(saved);
    const bytes = sizeOf(file);
    if (bytes > 0) return { uri: file.uri, size: bytes };
  }
  if (size === undefined) return null;
  const file = new File(cacheDir(connectionId, libraryId, path), cacheName(size));
  const cached = sizeOf(file);
  return cached > 0 ? { uri: file.uri, size: cached } : null;
}

/** The reader's cached copy of the book's EPUB for the server's `size`, else null: a
 * download takes it instead of fetching the book again (`runOne` in the downloads store). */
export async function cachedEbookUri({
  connectionId,
  libraryId,
  path,
  size,
}: Omit<EbookFileRef, 'saved'>): Promise<string | null> {
  return existingEbook({ connectionId, libraryId, path, size })?.uri ?? null;
}

/** Whether the book's EPUB is on this device without a fetch (`existingEbook`). The
 * offline place lookup asks it (`lookupReadingPlace`, which takes a throw as no). */
export async function hasLocalEbook(ref: EbookFileRef): Promise<boolean> {
  return existingEbook(ref) !== null;
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
