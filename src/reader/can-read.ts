import type { Book } from '@/api/types';

/**
 * Whether a book offers Read (Bridge Phase 3b): its server has the reader (capability
 * `ebooks`), the book has an ebook, and this is the web. The app's own reader host (a
 * WebView) is Phase 3b-2; until then Read is web only.
 */
export function canRead(
  ebooks: boolean | undefined,
  book: Pick<Book, 'ebook'> | undefined,
  os: string,
): boolean {
  return ebooks === true && !!book?.ebook && os === 'web';
}
