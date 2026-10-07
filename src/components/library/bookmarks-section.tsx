import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useBookmarks, useCapability } from '@/api/hooks';
import { useCid } from '@/api/provider';
import {
  AddBookmarkAction,
  type AnnotationTarget,
  BookmarkRow,
  JournalLink,
  useChapterNamer,
} from '@/components/annotations';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { byPosition } from '@/lib/by-position';

/**
 * A book's bookmarks (the book page's Bookmarks tab, the player companion's): "Bookmark
 * 17:26:50" and "See all in your journal" on top, then one `BookmarkRow` per bookmark in
 * book order (jump, label, note, chapter, age, edit, delete with Undo), with loading,
 * error and empty states.
 *
 * Without `addButton` or `emptyLabel` and with no bookmarks it renders nothing (an inline
 * use that only lists them).
 */
export function BookmarksSection({
  libraryId,
  path,
  connectionId,
  emptyLabel,
  addButton,
  onJump,
}: {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one (the book screen). The player
   * passes the playing book's connection so it addresses the right server. */
  connectionId?: string;
  /** The empty state's headline ("No bookmarks yet."). */
  emptyLabel?: string;
  /** Replaces the "Bookmark 17:26:50" action at the top. */
  addButton?: ReactNode;
  /** Where a tap on a bookmark's time goes. The player's companion seeks the playing
   * book in place (a jump, so the Undo chip follows); without it `useJumpTo` decides. */
  onJump?: (position: number) => void;
}) {
  const { t } = useTranslation();
  const cid = useCid(connectionId);
  const target: AnnotationTarget = useMemo(
    () => ({ connectionId: cid, libraryId, path }),
    [cid, libraryId, path],
  );
  const query = useBookmarks(libraryId, path, connectionId);
  const annotations = useCapability('annotations', cid);
  const chapterAt = useChapterNamer(target);
  const bookmarks = useMemo(() => byPosition(query.data ?? []), [query.data]);
  const empty = bookmarks.length === 0;

  if (query.isSuccess && empty && !addButton && !emptyLabel) return null;

  return (
    <View>
      <View className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
        {addButton ?? <AddBookmarkAction target={target} />}
        {annotations === true ? <JournalLink tab="bookmarks" /> : null}
      </View>
      {query.isPending ? (
        <RowSkeletonList count={3} />
      ) : query.isError ? (
        <EmptyState
          icon="circle-exclamation"
          title={t('annotations.bookmark.loadFailed')}
          action={{ label: t('common.retry'), onPress: () => void query.refetch() }}
          className="py-6"
        />
      ) : empty ? (
        <EmptyState
          icon="bookmark"
          title={emptyLabel ?? t('player.bookmarks.empty')}
          hint={t(
            Platform.OS === 'web'
              ? 'annotations.bookmark.emptyHintWeb'
              : 'annotations.bookmark.emptyHintNative',
          )}
          className="py-6"
        />
      ) : (
        bookmarks.map((bm, i) => (
          <BookmarkRow
            key={bm.id}
            bookmark={bm}
            connectionId={cid}
            chapter={chapterAt(bm.position)}
            onJump={onJump}
            first={i === 0}
          />
        ))
      )}
    </View>
  );
}
