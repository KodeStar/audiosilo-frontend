import { type ReactNode, useDeferredValue, useMemo, useState } from 'react';
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

import { annotationHaystack, matchesWords, searchWords } from './journal-model';
import { fetchMoreOf, MoreSpinner, useJournalListProps } from './journal-list';
import { mergeNewestFirst, overallStatus, type Sourced } from './merge-model';
import { ServerNotes } from './server-notes';
import type { Source } from './use-journal-sources';

type Row = Sourced<MyBookmark> | Sourced<MyNote>;

/** The Bookmarks tab's label filter: every label, one label, or the sleep timer's marks. */
type LabelFilter = 'all' | BookmarkLabel;

/** The label chips, in order: All labels, the pickable labels, Fell asleep. */
const LABEL_FILTERS: readonly LabelFilter[] = [
  'all',
  ...PICKABLE_BOOKMARK_LABELS,
  FELL_ASLEEP_LABEL,
];

/** Whether the label filter keeps a row. "Fell asleep" goes by `isDriftBookmark` (an
 * older server can only say it through the note); a note has no label. */
function labelKeeps(label: LabelFilter, row: Row): boolean {
  if (label === 'all') return true;
  if ('body' in row) return false;
  return label === FELL_ASLEEP_LABEL ? isDriftBookmark(row) : row.label === label;
}

/** One bookmark or note, with the chapter at its place (its book's chapters, read once
 * per book and shared through `qk.chapters`; null until they come or when it has none). */
function JournalRow({ row, first, server }: { row: Row; first: boolean; server?: string }) {
  const chapter = useChapterNamer({
    connectionId: row.connectionId,
    libraryId: row.library_id,
    path: row.path,
  })(row.position);
  const shared = { connectionId: row.connectionId, book: row.book, chapter, first, server };
  return 'body' in row ? (
    <NoteRow note={row} {...shared} />
  ) : (
    <BookmarkRow bookmark={row} {...shared} />
  );
}

/** The bottom of the rows' card: drawn over the last row's bottom padding (so its
 * corners round like a card's), from the list's footer so no row has to know it is the
 * last one (an appended page would re-render every row). Touches pass through it. */
function CardFoot() {
  return (
    <View
      className="-mt-3 h-4 rounded-b-card border-x border-b border-border bg-card"
      style={{ pointerEvents: 'none' }}
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
  sources,
}: {
  kind: 'bookmarks' | 'notes';
  header: ReactNode;
  query: string;
  /** The servers' lists of `kind`. */
  sources: Source<MyBookmark>[] | Source<MyNote>[];
}) {
  const { t } = useTranslation();
  const { press } = useTabPress();
  const listProps = useJournalListProps();
  const serverFlag = useServerFlag();
  const [label, setLabel] = useState<LabelFilter>('all');
  const merged = useMemo(
    () => mergeNewestFirst<MyBookmark | MyNote>(sources, (r) => r.created_at),
    [sources],
  );
  // The list follows the typing a beat behind, so a keystroke never waits on the filter.
  const deferred = useDeferredValue(query);
  const rows = useMemo(() => {
    const words = searchWords(deferred);
    return merged.rows.filter(
      (r) => labelKeeps(label, r) && matchesWords(words, annotationHaystack(r)),
    );
  }, [merged.rows, label, deferred]);
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
      keyExtractor={(r) => `${r.connectionId}\n${r.id}`}
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
          )}
        >
          <JournalRow row={item} first={index === 0} server={serverFlag(item.connectionId)} />
        </View>
      )}
      ListEmptyComponent={empty}
      ListFooterComponent={
        <>
          {rows.length > 0 ? <CardFoot /> : null}
          <MoreSpinner visible={merged.isFetchingMore} />
        </>
      }
      onEndReached={() => fetchMoreOf(sources, merged.fetchFrom)}
    />
  );
}
