import type { Book } from '@/api/types';

/**
 * Whether a book offers Read (Bridge Phase 3b): its server has the reader (capability
 * `ebooks`) and the book has an ebook. Every platform reads: the web in its iframe, the app
 * in its WebView (Phase 3b-2). A book whose download holds the EPUB (`downloadedEbook`:
 * `manifest.ebookUri`) reads while the capability is unknown too (offline, before this
 * device ever read the server's `/server`); a server that says no (`false`) never.
 */
export function canRead(
  ebooks: boolean | undefined,
  book: Pick<Book, 'ebook'> | undefined,
  downloadedEbook = false,
): boolean {
  if (!book?.ebook) return false;
  return ebooks === true || (ebooks === undefined && downloadedEbook);
}
