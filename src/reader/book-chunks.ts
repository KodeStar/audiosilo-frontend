import type { HostMessage, OpenFields } from './protocol';

/**
 * The app's book transfer (Bridge Phase 3b-2): the reader WebView has no file or network
 * access at all, so the host reads the local EPUB (its download, else the reader's cache
 * file) a piece at a time and posts each piece as base64 over the WebView's bridge; the
 * reader assembles them (`reader/src/chunks.js`) and refuses anything out of order, missing
 * or the wrong size.
 *
 * 256 KB a piece: measured on Pride and Prejudice (24.8 MB) on the iOS simulator and the
 * Android emulator, it opened as fast as 1 and 2 MB pieces with the lowest peak memory (the
 * Phase 3b-2 proof: 463 MB on iOS and 328 MB PSS on Android, about 1.05x a plain file load).
 * One piece is read only once the last one was posted, so at most one piece's base64 is held
 * on this side at a time.
 */
export const CHUNK_BYTES = 256 * 1024;

/** How many pieces a book of `size` bytes comes in. */
export function chunkCount(size: number): number {
  return Math.ceil(size / CHUNK_BYTES);
}

/** Reads `length` bytes of the book from `position`, as base64. */
export type ChunkReader = (position: number, length: number) => Promise<string>;

/**
 * Posts a book of `size` bytes in chunks: `open` (with the size and the count) first, then
 * every chunk in order. Stops between chunks once `cancelled()` says so (the reader went
 * away, or another transfer started), resolving false; true once the last chunk is posted.
 * A read that fails rejects, and the reader, missing its chunks, never opens the book.
 */
export async function sendInChunks(
  size: number,
  open: OpenFields,
  read: ChunkReader,
  post: (message: HostMessage) => void,
  cancelled: () => boolean,
): Promise<boolean> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('the book file is empty');
  const chunks = chunkCount(size);
  post({ type: 'open', ...open, size, chunks });
  for (let seq = 0; seq < chunks; seq++) {
    const position = seq * CHUNK_BYTES;
    const data = await read(position, Math.min(CHUNK_BYTES, size - position));
    if (cancelled()) return false;
    post({ type: 'chunk', seq, data });
  }
  return true;
}
