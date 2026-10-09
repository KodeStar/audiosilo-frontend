import { useMemo } from 'react';

import { useBookProgress } from '@/api/hooks';
import type {
  BookMetaAttribution,
  BookMetaCharacter,
  BookMetaRecap,
  BookMetaRecapSummary,
} from '@/api/types';
import type { ListeningProgress } from '@/components/library/meta-gating';
import { useBookCommunity } from '@/components/library/use-book-community';
import { contentKey } from '@/lib/content-key';

import { useListeningChapter } from '../use-listening-position';
import type { PlayTarget } from '../use-play-book';

/** Where the companion's community data stands: `off` (the server has no `metadata`, or
 * has not said yet), `loading` (nothing renders yet), `none` (unmatched, or the lookup
 * failed: the panels say so kindly) or `ready`. */
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
 * The community metadata of `target` and the listener's place in it, gated by the book
 * page's rules (`meta-gating.ts`: the same corrected chapter starts, the live place never
 * below the saved one) on the EXACT live place (`useListeningChapter`; the book page reads
 * it in `LIVE_POSITION_BUCKET_S` steps). Call it inside a `ConnectionScope` for the
 * book's own connection (the meta query reads the route scope).
 */
export function useCompanionData(target: PlayTarget): CompanionData {
  const { connectionId, libraryId, path } = target;
  const { metadata, enabled, chapterStarts, work, loading } = useBookCommunity(target);
  const { data: progress } = useBookProgress(libraryId, path, enabled, connectionId);
  const chapter = useListeningChapter(target, progress?.position, chapterStarts);
  const finished = !!progress?.finished;
  const listening = useMemo(() => ({ chapter, finished }), [chapter, finished]);

  // `metadata` still unknown counts as off (the phone's chips read it the same way): an
  // offline cold start or an unreachable server may never answer, and the community tabs
  // would sit blank, loading, for good.
  const status: CompanionStatus =
    metadata !== true ? 'off' : loading ? 'loading' : work ? 'ready' : 'none';

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
