import { useMemo } from 'react';

import { useBook, useBookMeta, useBookProgress, useCapability, useChapters } from '@/api/hooks';
import type {
  BookMetaAttribution,
  BookMetaCharacter,
  BookMetaRecap,
  BookMetaRecapSummary,
} from '@/api/types';
import { matchedMeta } from '@/components/library/book-meta';
import {
  chapterStartsOf,
  LIVE_POSITION_BUCKET_S,
  type ListeningProgress,
  listeningProgressFor,
} from '@/components/library/meta-gating';
import { contentKey } from '@/lib/content-key';

import { useListeningPosition } from '../use-listening-position';
import type { PlayTarget } from '../use-play-book';

/** Where the companion's community data stands: `off` (the server has no `metadata`),
 * `loading` (nothing renders yet), `none` (unmatched, or the lookup failed: the panels
 * say so kindly) or `ready`. */
export type CompanionStatus = 'off' | 'loading' | 'none' | 'ready';

export type CompanionData = {
  /** The book, by identity, and its `contentKey`. */
  target: PlayTarget;
  key: string;
  status: CompanionStatus;
  characters: BookMetaCharacter[];
  recaps: BookMetaRecap[];
  summary?: BookMetaRecapSummary;
  /** The server's CC BY-SA credit for this work's community content. */
  attribution?: BookMetaAttribution;
  /** Where the listener is, for the gate: ONE whole-book position (the live one while
   * this book is loaded, never below the saved one) on the corrected chapter starts. */
  listening: ListeningProgress;
};

const NO_CHARACTERS: BookMetaCharacter[] = [];
const NO_RECAPS: BookMetaRecap[] = [];

/**
 * The community metadata of `target` and the listener's place in it, gated exactly as
 * the book page gates it (`meta-gating.ts`: the same position, the same corrected
 * chapter starts, the same live bucket). Call it inside a `ConnectionScope` for the
 * book's own connection (the meta query reads the route scope).
 */
export function useCompanionData(target: PlayTarget): CompanionData {
  const { connectionId, libraryId, path } = target;
  const metadata = useCapability('metadata', connectionId);
  const { data: book, isLoading: bookLoading } = useBook(libraryId, path, connectionId);
  const metaEnabled = metadata === true && !!(book?.asin || book?.isbn);
  const meta = useBookMeta(libraryId, path, metaEnabled);
  const { data: progress } = useBookProgress(libraryId, path, metaEnabled, connectionId);
  const { data: chapterData, isLoading: chaptersLoading } = useChapters(
    libraryId,
    path,
    connectionId,
  );
  const chapterStarts = useMemo(
    () => chapterStartsOf(chapterData?.chapters ?? [], chapterData?.files ?? []),
    [chapterData],
  );
  const position = useListeningPosition(target, progress?.position, LIVE_POSITION_BUCKET_S);
  const listening = listeningProgressFor({
    chapterStarts,
    position,
    finished: !!progress?.finished,
  });

  const work = matchedMeta(meta.data, metaEnabled)?.work;
  const status: CompanionStatus =
    metadata === false
      ? 'off'
      : // The chapters place the listener: without them everyone past chapter 1 would
        // flash hidden, then appear.
        metadata === undefined || bookLoading || chaptersLoading || (metaEnabled && meta.isLoading)
        ? 'loading'
        : work
          ? 'ready'
          : 'none';

  return {
    target,
    key: contentKey(connectionId, libraryId, path),
    status,
    characters: work?.characters ?? NO_CHARACTERS,
    recaps: work?.recaps ?? NO_RECAPS,
    summary: work?.recap_summary,
    attribution: work?.attribution,
    listening,
  };
}
