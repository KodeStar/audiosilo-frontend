import { useMemo } from 'react';

import { useBook, useBookMeta, useCapability, useChapters } from '@/api/hooks';
import type { Book, BookMetaWork, ChaptersResponse } from '@/api/types';

import { matchedMeta } from './book-meta';
import { chapterStartsOf, metaEnabledFor } from './meta-gating';

/** A book's community metadata and what the spoiler gate needs to place the listener. */
export type BookCommunity = {
  /** The server's `metadata` capability (undefined while unknown). */
  metadata: boolean | undefined;
  book: Book | undefined;
  /** The book can have community metadata (`metaEnabledFor`): only then is `/meta`
   * (and the chapters, for the gate) asked for. */
  enabled: boolean;
  chapterData: ChaptersResponse | undefined;
  /** The corrected whole-book start of every chapter (`chapterStartsOf`), for the gate. */
  chapterStarts: number[];
  /** The matched community work, when there is one. */
  work: BookMetaWork | undefined;
  /** Something the answer depends on is still on its way. */
  loading: boolean;
};

/**
 * The community-metadata chain every spoiler-gated surface beside the book page reads
 * (the player's companion, its reveal toast, Home's Previously on): the server's
 * `metadata` flag, then the book (for its ASIN or ISBN), then `/meta` and the chapters,
 * then the corrected chapter starts and the matched work. Each step waits on the one
 * before, so nothing is asked of a server without `metadata` or for a book that can't
 * match. Call it inside a `ConnectionScope` for the book's own connection (the `/meta`
 * query reads the route scope).
 */
export function useBookCommunity(target: {
  connectionId: string;
  libraryId: number;
  path: string;
}): BookCommunity {
  const { connectionId, libraryId, path } = target;
  const metadata = useCapability('metadata', connectionId);
  const { data: book, isLoading: bookLoading } = useBook(libraryId, path, connectionId, {
    enabled: metadata === true,
  });
  const enabled = metaEnabledFor(metadata, book);
  const meta = useBookMeta(libraryId, path, enabled);
  const { data: chapterData, isLoading: chaptersLoading } = useChapters(
    libraryId,
    path,
    connectionId,
    { enabled },
  );
  const chapterStarts = useMemo(
    () => chapterStartsOf(chapterData?.chapters ?? [], chapterData?.files ?? []),
    [chapterData],
  );
  return {
    metadata,
    book,
    enabled,
    chapterData,
    chapterStarts,
    work: matchedMeta(meta.data, enabled)?.work,
    // The chapters place the listener: without them everyone past chapter 1 would
    // flash hidden, then appear.
    loading: metadata === undefined || bookLoading || chaptersLoading || meta.isLoading,
  };
}
