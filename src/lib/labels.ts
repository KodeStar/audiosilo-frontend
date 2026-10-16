import type { Book } from '@/api/types';

/**
 * A book's labels: its genres and its tags (the book page's chips, the Library's
 * filters). The server sends each list already clean (each label trimmed with its inner
 * spacing collapsed, blanks dropped, each once by `labelKey`), so a client shows and
 * counts them as they come.
 */

/** The book's label lists: its genres and its tags. */
export const LABEL_KINDS = ['genre', 'tag'] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

/** A genre or tag as it compares: trimmed, inner whitespace collapsed, lower-cased, so
 * "Science  Fiction" and "science fiction" are one label. Mirrors the server's
 * `catalog.labelKey` (internal/catalog/labels.go), which `?genre=` and `?tag=` match by;
 * a URL param or a link's label goes through it, as typed or pasted. */
export function labelKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A book's genres or tags (none from an older server). */
export function bookLabels(book: Pick<Book, 'genres' | 'tags'>, kind: LabelKind): string[] {
  return (kind === 'genre' ? book.genres : book.tags) ?? [];
}
