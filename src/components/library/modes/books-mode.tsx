import type { FlashListRef } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { useAllProgressAll } from '@/api/hooks';
import type { Book, Progress } from '@/api/types';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { SubNavActions } from '@/components/shell/tab-root-nav';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ChipRow, ChipSeparator, FilterChip } from '@/components/ui/filter-chip';
import { GhostCovers, GhostSpines } from '@/components/ui/ghost-art';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { downloadedPaths } from '@/downloads/downloads-view';
import { useDownloads } from '@/downloads/store';
import { headIndexForLetter, presentLetters } from '@/lib/alpha-sections';
import { formatCount } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { tabularNums } from '@/theme/tabular-nums';

import { AzRail } from '../books/az-rail';
import { BookListHeader, BookListRow, BookTile } from '../books/book-items';
import { listColumns } from '../books/list-columns';
import { LoadError } from '../books/book-states';
import { BooksControls } from '../books/books-controls';
import { useBooksLayout } from '../books/books-layout-store';
import {
  BOOK_STATUSES,
  type BookFacts,
  type BooksGridItem,
  type BooksView,
  booksViewKey,
  booksViewParams,
  bookStatus,
  filterBooks,
  hasFilters,
  LENGTH_BUCKETS,
  letterGrid,
  parseBooksView,
  progressByPath,
  sortBooks,
  statusCounts,
} from '../books/books-view';
import { useWholeLibrary } from '../books/use-whole-library';
import { CoverGrid, CoverGridSkeleton } from '../cover-grid';
import { pageGutter } from '../cover-layout';
import type { LibraryModeProps } from '../library-modes';
import { useSelectedLibrary } from '../use-selected-library';

const STATUS_KEY = {
  new: 'library.books.filters.new',
  progress: 'library.books.filters.progress',
  finished: 'library.books.filters.finished',
} as const;

const LENGTH_KEY = {
  short: 'library.books.filters.short',
  mid: 'library.books.filters.mid',
  long: 'library.books.filters.long',
} as const;

const itemKey = (item: BooksGridItem) =>
  item.kind === 'head' ? `#${item.letter}` : `b:${item.item.rel_path}`;

/**
 * The Library tab's Books mode for the selected library: the whole list loaded page by
 * page, then filtered (status, downloaded, length) and sorted on the device, as a cover
 * grid or a list. The sort and filters live in the URL (the shared deep-link contract:
 * `sort`, `status`, `dl`, `len`), the grid/list choice on the device. Title order adds
 * letter heads and an A-Z rail.
 */
export function BooksMode({ connectionId, libraryId }: LibraryModeProps) {
  const { t } = useTranslation();
  const layout = useLayout();
  const phone = layout === 'phone';
  const reduceMotion = useReducedMotion();
  const params = useLocalSearchParams<{
    sort?: string;
    status?: string;
    dl?: string;
    len?: string;
  }>();
  const view = useMemo(
    () =>
      parseBooksView({ sort: params.sort, status: params.status, dl: params.dl, len: params.len }),
    [params.sort, params.status, params.dl, params.len],
  );
  const setView = (next: Partial<BooksView>) =>
    router.setParams(booksViewParams({ ...view, ...next }));
  const clearFilters = () => setView({ status: undefined, dl: false, len: undefined });
  const [booksLayout, setBooksLayout] = useBooksLayout();
  const libraryName = useSelectedLibrary().library?.name ?? '';

  const whole = useWholeLibrary(connectionId, libraryId);
  const { progress } = useAllProgressAll();
  const progressMap = useMemo(
    () =>
      progressByPath(
        progress.filter((p) => p.connectionId === connectionId && p.library_id === libraryId),
      ),
    [progress, connectionId, libraryId],
  );
  const canDownload = useDownloads((s) => s.supported);
  // This library's downloaded books as one string, read only while the filter is on: a
  // running download updates the registry several times a second, and the list
  // re-filters only when a book finishes or goes.
  const downloadedList = useDownloads((s) =>
    view.dl ? downloadedPaths(s.entries, connectionId, libraryId) : '',
  );
  const factsOf = useMemo(() => {
    const downloaded = new Set(downloadedList.split('\n'));
    return (b: Book): BookFacts => ({
      status: bookStatus(progressMap.get(b.rel_path)),
      downloaded: downloaded.has(b.rel_path),
    });
  }, [progressMap, downloadedList]);

  const shown = useMemo(
    () => sortBooks(filterBooks(whole.books, view, factsOf), view.sort),
    [whole.books, view, factsOf],
  );
  const counts = useMemo(
    () => statusCounts(whole.books, view, factsOf),
    [whole.books, view, factsOf],
  );
  const az = view.sort === 'title';
  const grid = useMemo(
    () =>
      az
        ? letterGrid(shown)
        : { items: shown.map((item): BooksGridItem => ({ kind: 'item', item })), heads: [] },
    [az, shown],
  );
  const present = useMemo(() => presentLetters(grid.heads), [grid.heads]);

  const listRef = useRef<FlashListRef<BooksGridItem>>(null);
  // A new sort or filter opens the list at the top. FlashList keeps the first visible
  // item in place when its data changes (`maintainVisibleContentPosition`, by item
  // key): right while pages arrive, wrong for a new order (Title opened at "M", where
  // the old top book files). So the item keys are scoped to the view, leaving nothing
  // to anchor to across a change, and the change scrolls to the top; a page arriving
  // changes neither, so the listener keeps their place.
  const viewKey = booksViewKey(view);
  const keyOf = useCallback((item: BooksGridItem) => `${viewKey}/${itemKey(item)}`, [viewKey]);
  const shownView = useRef(viewKey);
  useEffect(() => {
    if (shownView.current === viewKey) return;
    shownView.current = viewKey;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [viewKey]);
  const jump = (letter: string) => {
    const index = headIndexForLetter(grid.heads, letter);
    if (index >= 0) void listRef.current?.scrollToIndex({ index, animated: !reduceMotion });
  };

  const filtered = hasFilters(view);
  const total = whole.books.length;
  const more = whole.complete ? '' : '+';
  const countLine = filtered
    ? t('library.books.matches', {
        count: shown.length,
        shown: formatCount(shown.length),
        total: `${formatCount(total)}${more}`,
      })
    : t('library.books.count', { count: total, formatted: `${formatCount(total)}${more}` });

  const controls = (
    <BooksControls
      sort={view.sort}
      onSort={(sort) => setView({ sort })}
      layout={booksLayout}
      onLayout={setBooksLayout}
    />
  );
  const gutter = pageGutter(layout);
  // The list's columns follow the body's measured width (less the gutters), not the
  // window's: the Up next drawer can leave a desktop list tablet-narrow.
  const [bodyWidth, setBodyWidth] = useState(0);
  const columns = listColumns(layout, bodyWidth > 0 ? bodyWidth - gutter * 2 : 0);
  const header = (
    <View className="gap-3 pb-4">
      <ChipRow accessibilityLabel={t('library.books.filters.label')} gutter={gutter}>
        {BOOK_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={t(STATUS_KEY[s])}
            count={whole.isLoading ? undefined : counts[s]}
            selected={view.status === s}
            onPress={() => setView({ status: view.status === s ? undefined : s })}
          />
        ))}
        {canDownload ? (
          <>
            <ChipSeparator />
            <FilterChip
              label={t('library.books.filters.downloaded')}
              icon="download"
              selected={view.dl}
              onPress={() => setView({ dl: !view.dl })}
            />
          </>
        ) : null}
        <ChipSeparator />
        {LENGTH_BUCKETS.map((l) => (
          <FilterChip
            key={l}
            label={t(LENGTH_KEY[l])}
            selected={view.len === l}
            onPress={() => setView({ len: view.len === l ? undefined : l })}
          />
        ))}
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            icon="close"
            title={t('library.books.filters.clear')}
            onPress={clearFilters}
          />
        ) : null}
      </ChipRow>
      <View className="min-h-[38px] flex-row items-center justify-between gap-3">
        <Text variant="muted" style={tabularNums} accessibilityLiveRegion="polite">
          {whole.isLoading ? ' ' : countLine}
        </Text>
        {phone ? controls : null}
      </View>
      {whole.error && total > 0 ? (
        <LoadError
          compact
          title={t('library.books.error.partial')}
          hint={t('library.books.error.partialHint', {
            count: total,
            formatted: formatCount(total),
          })}
          retryLabel={t('common.retry')}
          onRetry={whole.retry}
        />
      ) : null}
      {booksLayout === 'list' && shown.length > 0 ? <BookListHeader columns={columns} /> : null}
    </View>
  );

  const emptyBody = () => {
    if (whole.isLoading) {
      return booksLayout === 'grid' ? (
        <CoverGridSkeleton rows={3} gutter={0} />
      ) : (
        <RowSkeletonList count={6} />
      );
    }
    if (whole.error && total === 0) {
      return (
        <LoadError
          title={t('library.books.error.title')}
          hint={t('library.books.error.hint')}
          retryLabel={t('common.retry')}
          onRetry={whole.retry}
        />
      );
    }
    if (total === 0) {
      return (
        <EmptyState
          variant="card"
          art={<GhostSpines />}
          title={t('library.books.empty.title', { library: libraryName })}
          hint={t('library.books.empty.hint')}
          action={{ label: t('library.books.empty.action'), onPress: whole.refresh }}
        />
      );
    }
    // Still loading pages: what matches may be on the next one.
    if (!whole.complete) return null;
    return (
      <EmptyState
        variant="card"
        art={<GhostCovers />}
        title={t('library.books.noMatches.title')}
        hint={t('library.books.noMatches.hint')}
        action={{ label: t('library.books.noMatches.action'), onPress: clearFilters }}
      />
    );
  };
  const empty = emptyBody();

  const footer =
    !whole.complete && !whole.error && total > 0 ? (
      <Text variant="caption" className="py-4 text-center">
        {t('library.books.loadingMore')}
      </Text>
    ) : null;

  const progressOf = (b: Book): Progress | undefined => progressMap.get(b.rel_path);
  const renderHead = (letter: string) => (
    <View className="-mb-3 border-b border-border pb-1.5 pt-1">
      <Text variant="heading" className="text-[22px]" accessibilityRole="header">
        {letter}
      </Text>
    </View>
  );

  const body =
    booksLayout === 'grid' ? (
      <CoverGrid
        listRef={listRef}
        data={grid.items}
        keyExtractor={keyOf}
        isFullRow={(item) => item.kind === 'head'}
        renderItem={(item, tile) =>
          item.kind === 'head' ? (
            renderHead(item.letter)
          ) : (
            <BookTile
              connectionId={connectionId}
              libraryId={libraryId}
              book={item.item}
              sort={view.sort}
              width={tile}
            />
          )
        }
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
      />
    ) : (
      <BooksList
        listRef={listRef}
        items={grid.items}
        keyExtractor={keyOf}
        gutter={gutter}
        renderHead={renderHead}
        renderBook={(book) => (
          <BookListRow
            connectionId={connectionId}
            libraryId={libraryId}
            book={book}
            progress={progressOf(book)}
            columns={columns}
          />
        )}
        header={header}
        empty={empty}
        footer={footer}
      />
    );

  return (
    <View className="flex-1">
      {phone ? null : (
        <SubNavActions tab="(library)" id="books-controls">
          {controls}
        </SubNavActions>
      )}
      <View className="flex-1 flex-row">
        <View className="flex-1" onLayout={(e) => setBodyWidth(e.nativeEvent.layout.width)}>
          {body}
        </View>
        {az && present.size > 1 ? (
          <View className={phone ? 'pr-1 pt-24' : 'pr-2 pt-28'}>
            <AzRail present={present} onJump={jump} compact={phone} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The list layout: one row per book (and letter heads in title order), the page's
 * scroller like `CoverGrid`. */
function BooksList({
  listRef,
  items,
  keyExtractor,
  gutter,
  renderHead,
  renderBook,
  header,
  empty,
  footer,
}: {
  listRef: React.Ref<FlashListRef<BooksGridItem>>;
  items: BooksGridItem[];
  keyExtractor: (item: BooksGridItem) => string;
  gutter: number;
  renderHead: (letter: string) => React.ReactElement;
  renderBook: (book: Book) => React.ReactElement;
  header: React.ReactElement;
  empty: React.ReactElement | null;
  footer: React.ReactElement | null;
}) {
  const paddingBottom = useMiniPlayerInset();
  return (
    <FlashList
      ref={listRef}
      data={items}
      keyExtractor={keyExtractor}
      getItemType={(item) => item.kind}
      renderItem={({ item }) =>
        item.kind === 'head' ? (
          <View className="pb-4 pt-3">{renderHead(item.letter)}</View>
        ) : (
          renderBook(item.item)
        )
      }
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 4, paddingBottom }}
    />
  );
}
