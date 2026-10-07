import type { UseQueryResult } from '@tanstack/react-query';
import type { ParseKeys } from 'i18next';
import { type ComponentType, type ReactElement, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useBookmarks, useCapability, useNotes } from '@/api/hooks';
import { useCid } from '@/api/provider';
import { EmptyState } from '@/components/ui/empty-state';
import type { IconName } from '@/components/ui/icon';
import { RowSkeletonList } from '@/components/ui/skeleton';
import type { AnnotationKind, AnnotationOf, AnnotationTarget } from '@/lib/annotation-request';
import { byPosition } from '@/lib/by-position';

import type { AnnotationRowProps } from './annotation-row';
import { BookmarkRow } from './bookmark-row';
import { NoteRow } from './note-row';
import { AddBookmarkAction, AddNoteAction, JournalLink } from './section-actions';
import { useChapterNamer } from './use-book-place';

/** What tells a book's bookmarks from its notes: the list, the add action, the journal
 * tab, the loading shape, the copy and the row. */
const SECTION: {
  [K in AnnotationKind]: {
    useList: (
      libraryId: number,
      path: string,
      connectionId?: string,
    ) => UseQueryResult<AnnotationOf[K][]>;
    Add: ComponentType<{ target: AnnotationTarget }>;
    tab: 'bookmarks' | 'notes';
    skeletons: number;
    loadFailed: ParseKeys;
    icon: IconName;
    empty: ParseKeys;
    hint: () => ParseKeys;
    Row: (props: AnnotationRowProps & { row: AnnotationOf[K] }) => ReactElement;
  };
} = {
  bookmark: {
    useList: useBookmarks,
    Add: AddBookmarkAction,
    tab: 'bookmarks',
    skeletons: 3,
    loadFailed: 'annotations.bookmark.loadFailed',
    icon: 'bookmark',
    empty: 'player.bookmarks.empty',
    hint: () =>
      Platform.OS === 'web'
        ? 'annotations.bookmark.emptyHintWeb'
        : 'annotations.bookmark.emptyHintNative',
    Row: ({ row, ...props }) => <BookmarkRow bookmark={row} {...props} />,
  },
  note: {
    useList: useNotes,
    Add: AddNoteAction,
    tab: 'notes',
    skeletons: 2,
    loadFailed: 'annotations.note.loadFailed',
    icon: 'notes',
    empty: 'annotations.note.empty',
    hint: () => 'annotations.note.emptyHint',
    Row: ({ row, ...props }) => <NoteRow note={row} {...props} />,
  },
};

/** Where a book's bookmarks or notes are listed, and for which book. */
export type AnnotationSectionProps = {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one (the book screen). The player passes
   * the playing book's connection so it addresses the right server. */
  connectionId?: string;
  /** Where a tap on a row's time goes. The player's companion seeks the playing book in
   * place (a jump, so the Undo chip follows); without it `useJumpTo` decides. */
  onJump?: (position: number) => void;
};

/**
 * A book's bookmarks or notes (the book page's tabs, the player companion's): the add
 * action ("Bookmark 17:26:50", "Note at 17:26:50") and "See all in your journal" (where
 * the server lists them across books) on top, then one row each in book order, with
 * loading, error and empty states.
 */
export function AnnotationSection<K extends AnnotationKind>({
  kind,
  libraryId,
  path,
  connectionId,
  onJump,
}: AnnotationSectionProps & { kind: K }) {
  const { t } = useTranslation();
  const { useList, Add, tab, skeletons, loadFailed, icon, empty, hint, Row } = SECTION[kind];
  const cid = useCid(connectionId);
  const target: AnnotationTarget = useMemo(
    () => ({ connectionId: cid, libraryId, path }),
    [cid, libraryId, path],
  );
  const query = useList(libraryId, path, connectionId);
  const annotations = useCapability('annotations', cid);
  const chapterAt = useChapterNamer(target);
  const rows = useMemo(() => byPosition(query.data ?? []), [query.data]);

  return (
    <View>
      <View className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <Add target={target} />
        {annotations === true ? <JournalLink tab={tab} /> : null}
      </View>
      {query.isPending ? (
        <RowSkeletonList count={skeletons} />
      ) : query.isError ? (
        <EmptyState
          icon="circle-exclamation"
          title={t(loadFailed)}
          action={{ label: t('common.retry'), onPress: () => void query.refetch() }}
          className="py-6"
        />
      ) : rows.length === 0 ? (
        <EmptyState icon={icon} title={t(empty)} hint={t(hint())} className="py-6" />
      ) : (
        rows.map((row, i) => (
          <Row
            key={row.id}
            row={row}
            connectionId={cid}
            chapter={chapterAt(row.position)}
            onJump={onJump}
            first={i === 0}
          />
        ))
      )}
    </View>
  );
}
