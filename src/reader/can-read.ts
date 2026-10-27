import type { Book } from '@/api/types';

/**
 * Whether a book offers Read (Bridge Phase 3b): its server has the reader (capability
 * `ebooks`) and the book has an ebook. Every platform reads: the web in its iframe, the app
 * in its WebView (Phase 3b-2).
 */
export function canRead(
  ebooks: boolean | undefined,
  book: Pick<Book, 'ebook'> | undefined,
): boolean {
  return ebooks === true && !!book?.ebook;
}
