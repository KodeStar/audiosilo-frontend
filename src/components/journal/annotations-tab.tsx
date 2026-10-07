import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import { FELL_ASLEEP_LABEL, PICKABLE_BOOKMARK_LABELS } from '@/api/bookmark-labels';
import type { BookmarkLabel, MyBookmark, MyNote } from '@/api/types';
import {
  BookmarkRow,
  isDriftBookmark,
  labelText,
  NoteRow,
  useChapterNamer,
} from '@/components/annotations';
import { useServerFlag } from '@/components/library/cover-tile';
import { useTabPress } from '@/components/shell/destinations';
import { EmptyState } from '@/components/ui/empty-state';
import { ChipRow, FilterChip } from '@/components/ui/filter-chip';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { matchesQuery } from './journal-model';
import { fetchMoreOf, MoreSpinner, useJournalListProps } from './journal-list';
import { mergeNewestFirst, overallStatus, type Sourced } from './merge-model';
import { ServerNotes } from './server-notes';
import type { Source } from './use-journal-sources';

/** A row of the list: a bookmark or a note, with its server. */
type ListRow =
  { type: 'bookmark'; row: Sourced<MyBookmark> } | { type: 'note'; row: Sourced<MyNote> };

/** The Bookmarks tab's label filter: every label, one label, or the sleep timer's marks. */
export type LabelFilter = 'all' | BookmarkLabel;

/** The label chips, in order: All labels, the pickable labels, Fell asleep. */
export const LABEL_FILTERS: readonly LabelFilter[] = [
  'all',
  ...PICKABLE_BOOKMARK_LABELS,
  FELL_ASLEEP_LABEL,
];

/** The bookmarks the filter and the search keep. "Fell asleep" goes by `isDriftBookmark`
 * (an older server can only say it through the note); the search looks at the book's
 * title and author and the note. */
export function filterBookmarks<B extends MyBookmark>(
  rows: readonly B[],
  label: LabelFilter,
  query: string,
): B[] {
  return rows.filter(
    (b) =>
      (label === 'all' || (label === FELL_ASLEEP_LABEL ? isDriftBookmark(b) : b.label === label)) &&
      matchesQuery(query, b.book?.title, b.book?.author, b.note),
  );
}

/** The notes the search keeps (the book's title and author, the body). */
export function filterNotes<N extends MyNote>(rows: readonly N[], query: string): N[] {
  return rows.filter((n) => matchesQuery(query, n.book?.title, n.book?.author, n.body));
}

/** The chapter at a row's place, from its book's chapters (read once per book, shared
 * through `qk.chapters`); null until they come or when the book has none. */
function useRowChapter(row: Sourced<MyBookmark> | Sourced<MyNote>): string | null {
  return useChapterNamer({
    connectionId: row.connectionId,
    libraryId: row.library_id,
    path: row.path,
  })(row.position);
}

function JournalBookmark({ row, first }: { row: Sourced<MyBookmark>; first: boolean }) {
  const serverFlag = useServerFlag();
  return (
    <BookmarkRow
      bookmark={row}
      connectionId={row.connectionId}
      book={row.book}
      chapter={useRowChapter(row)}
      first={first}
      server={serverFlag(row.connectionId)}
    />
  );
}

function JournalNote({ row, first }: { row: Sourced<MyNote>; first: boolean }) {
  const serverFlag = useServerFlag();
  return (
    <NoteRow
      note={row}
      connectionId={row.connectionId}
      book={row.book}
      chapter={useRowChapter(row)}
      first={first}
      server={serverFlag(row.connectionId)}
    />
  );
}

/**
 * The Bookmarks or Notes tab: every server's list (gated on its own `annotations`),
 * merged newest first, filtered by the search (and, for bookmarks, the label chips), as
 * one card of rows. A server that can't list them says so above the list; when none can,
 * the tab says so plainly and points to the books' own pages (never a spinner).
 */
export function AnnotationsTab({
  kind,
  header,
  query,
  bookmarks,
  notes,
}: {
  kind: 'bookmarks' | 'notes';
  header: ReactNode;
  query: string;
  bookmarks: Source<MyBookmark>[];
  notes: Source<MyNote>[];
}) {
  const { t } = useTranslation();
  const { press } = useTabPress();
  const listProps = useJournalListProps();
  const [label, setLabel] = useState<LabelFilter>('all');
  const sources: Source<MyBookmark | MyNote>[] = kind === 'bookmarks' ? bookmarks : notes;
  const merged = useMemo(() => mergeNewestFirst(sources, (r) => r.created_at), [sources]);
  const rows = useMemo(
    (): ListRow[] =>
      kind === 'bookmarks'
        ? filterBookmarks(merged.rows as Sourced<MyBookmark>[], label, query).map((row) => ({
            type: 'bookmark',
            row,
          }))
        : filterNotes(merged.rows as Sourced<MyNote>[], query).map((row) => ({
            type: 'note',
            row,
          })),
    [kind, merged.rows, label, query],
  );
  const status = overallStatus(sources);
  const filtered = merged.rows.length > 0 && rows.length === 0;

  const empty =
    status === 'unsupported' ? (
      <EmptyState
        variant="card"
        icon="server"
        title={t(`journal.${kind}.unsupported.title`)}
        hint={t(`journal.${kind}.unsupported.hint`)}
        action={{ label: t('journal.openLibrary'), onPress: () => press('(library)') }}
      />
    ) : status === 'loading' ? (
      <RowSkeletonList count={5} />
    ) : status === 'error' ? (
      <EmptyState
        variant="card"
        icon="circle-exclamation"
        title={t(`journal.${kind}.error`)}
        action={{ label: t('common.retry'), onPress: () => sources.forEach((s) => s.refetch()) }}
      />
    ) : filtered ? (
      <EmptyState variant="card" icon="search" title={t(`journal.${kind}.noMatch`)} />
    ) : (
      <EmptyState
        variant="card"
        icon={kind === 'bookmarks' ? 'bookmark' : 'notes'}
        title={t(`journal.${kind}.empty.title`)}
        hint={t(`journal.${kind}.empty.hint`)}
      />
    );

  return (
    <FlatList
      {...listProps}
      testID="journal-list"
      data={rows}
      keyExtractor={(r) => `${r.type}\n${r.row.connectionId}\n${r.row.id}`}
      ListHeaderComponent={
        <>
          {header}
          <ServerNotes sources={sources} kind={kind} />
          {kind === 'bookmarks' && status !== 'unsupported' ? (
            <View className="pb-3">
              <ChipRow accessibilityLabel={t('journal.bookmarks.labels')}>
                {LABEL_FILTERS.map((l) => (
                  <FilterChip
                    key={l}
                    label={l === 'all' ? t('journal.bookmarks.allLabels') : (labelText(t, l) ?? l)}
                    selected={label === l}
                    onPress={() => setLabel(l)}
                  />
                ))}
              </ChipRow>
            </View>
          ) : null}
        </>
      }
      renderItem={({ item, index }) => (
        <View
          className={cn(
            'border-x border-border bg-card px-4',
            index === 0 && 'rounded-t-card border-t pt-1',
            index === rows.length - 1 && 'rounded-b-card border-b pb-1',
          )}
        >
          {item.type === 'bookmark' ? (
            <JournalBookmark row={item.row} first={index === 0} />
          ) : (
            <JournalNote row={item.row} first={index === 0} />
          )}
        </View>
      )}
      ListEmptyComponent={empty}
      ListFooterComponent={<MoreSpinner visible={merged.isFetchingMore} />}
      onEndReached={() => fetchMoreOf(sources, merged.fetchFrom)}
    />
  );
}
