// The native reader's book transfer (Bridge Phase 3b-2): the app reads the local EPUB and
// posts it in base64 chunks over the WebView bridge (`open {size, chunks}`, then `chunk
// {seq, data}` for seq 0..chunks-1); the reader assembles them into one buffer here. The
// page itself reads no file and makes no request (connect-src 'none'), so a WebView with
// every file access setting off can still open a book.
//
// Anything malformed is refused, never patched up: a chunk out of order, a repeated or
// missing one, data that is not base64, more bytes than announced, or fewer once the last
// chunk is in.

/** The largest book the reader takes (bytes): a bigger `size` is refused before anything
 * is allocated. */
export const MAX_BOOK_BYTES = 512 * 1024 * 1024;
/** The most chunks one book may come in. */
export const MAX_CHUNKS = 65536;

export class ChunkError extends Error {}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A book announced by `open`: `add` each chunk in order; it returns the whole book's
 * bytes (an ArrayBuffer) with the last one, null before. Throws a ChunkError when the
 * transfer is wrong in any way, after which it accepts nothing more. */
export function createAssembly(size, chunks) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_BOOK_BYTES) {
    throw new ChunkError('the book size is not valid');
  }
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS || chunks > size) {
    throw new ChunkError('the chunk count is not valid');
  }
  const bytes = new Uint8Array(size);
  let next = 0;
  let offset = 0;
  let failed = false;

  const fail = (message) => {
    failed = true;
    throw new ChunkError(message);
  };

  return {
    add(seq, data) {
      if (failed || next === chunks) fail('no chunk was expected');
      if (seq !== next) fail(`chunk ${String(seq)} arrived, chunk ${next} was expected`);
      if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0) {
        fail('a chunk is not base64');
      }
      if (!BASE64.test(data)) fail('a chunk is not base64');
      const binary = atob(data);
      if (offset + binary.length > size) fail('the book is larger than announced');
      for (let i = 0; i < binary.length; i++) bytes[offset + i] = binary.charCodeAt(i);
      offset += binary.length;
      next++;
      if (next < chunks) return null;
      if (offset !== size) fail('the book is smaller than announced');
      return bytes.buffer;
    },
  };
}

/** The longest read-along map text the reader takes (UTF-16 code units): the server bounds
 * the map file at 16 MiB, and the app sends only its sections and spans. */
export const MAX_MAP_LENGTH = 16 * 1024 * 1024;

/** A read-along map announced by `readalong {length, chunks}` (Bridge Phase 3c): its JSON
 * text, `add`ed a piece at a time in order (`readalongChunk {seq, data}`); `add` returns the
 * whole text with the last piece, null before. Refused as the book's chunks are: a piece out
 * of order, repeated or extra, one that is not a non-empty string, more text than announced,
 * or less once the last piece is in (a ChunkError, after which it accepts nothing). */
export function createTextAssembly(length, chunks) {
  if (!Number.isInteger(length) || length < 1 || length > MAX_MAP_LENGTH) {
    throw new ChunkError('the map length is not valid');
  }
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS || chunks > length) {
    throw new ChunkError('the chunk count is not valid');
  }
  const pieces = [];
  let next = 0;
  let received = 0;
  let failed = false;

  const fail = (message) => {
    failed = true;
    throw new ChunkError(message);
  };

  return {
    add(seq, data) {
      if (failed || next === chunks) fail('no chunk was expected');
      if (seq !== next) fail(`chunk ${String(seq)} arrived, chunk ${next} was expected`);
      if (typeof data !== 'string' || data.length === 0) fail('a chunk is not text');
      if (received + data.length > length) fail('the map is longer than announced');
      pieces.push(data);
      received += data.length;
      next++;
      if (next < chunks) return null;
      if (received !== length) fail('the map is shorter than announced');
      return pieces.join('');
    },
  };
}
