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
