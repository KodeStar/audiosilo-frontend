/**
 * Why the app's reader could not put a book's EPUB on the device (fe#172), apart from the
 * server's answers and the network: said in the reader's own words, never as "Couldn't load
 * the ebook" (`fetch`) or "can't be opened" (`unreadable`).
 */

/** The largest EPUB the app's reader takes (bytes): the reader document's own limit
 * (`MAX_BOOK_BYTES` in `reader/src/chunks.js`, which allocates the whole book at once). A
 * bigger one is refused before it is fetched or sent. */
export const MAX_EBOOK_BYTES = 512 * 1024 * 1024;

/** The EPUB is over `MAX_EBOOK_BYTES`: nothing on this device can open it. */
export class EbookTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`The ebook is too large to open (${size} bytes).`);
    this.name = 'EbookTooLargeError';
  }
}

/** The EPUB could not be written to the device: no space for it, or the cache could not be
 * written. Nothing partial is left behind. */
export class EbookStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EbookStorageError';
  }
}
