import type { FlashListRef } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { useAllProgressAll } from '@/api/hooks';
import type { Book, Progress } from '@/api/types';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { SubNavActions } from '@/components/shell/tab-root-nav';
import { Button } from '@/components/ui/button';
import { ChipRow, ChipSeparator, FilterChip } from '@/components/ui/filter-chip';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useDownloads } from '@/downloads/store';
import { contentKey } from '@/lib/content-key';
import { headIndexForLetter } from '@/lib/alpha-sections';
import { formatCount } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { tabularNums } from '@/theme/tabular-nums';
import { GhostCovers, GhostSpines } from '@/components/ui/ghost-art';
import { EmptyState } from '@/components/ui/empty-state';

import { AzRail } from '../books/az-rail';
import { BookListHeader, BookListRow, BookTile } from '../books/book-items';
import { LoadError } from '../books/book-states';
import { BooksControls } from '../books/books-controls';
import { useBooksLayout } from '../books/books-layout-store';
import {
  BOOK_STATUSES,
  type BookFacts,
  type BooksGridItem,
  type BooksView,
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
  const entries = useDownloads((s) => s.entries);
  const factsOf = useMemo(
    () =>
      (b: Book): BookFacts => ({
        status: bookStatus(progressMap.get(b.rel_path)),
        downloaded:
          entries[contentKey(connectionId, libraryId, b.rel_path)]?.status === 'downloaded',
      }),
    [progressMap, entries, connectionId, libraryId],
  );

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
  const present = useMemo(() => new Set(grid.heads.map((h) => h.letter)), [grid.heads]);

  const listRef = useRef<FlashListRef<BooksGridItem>>(null);
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
            onPress={() => setView({ status: undefined, dl: false, len: undefined })}
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
      {booksLayout === 'list' && !phone && shown.length > 0 ? <BookListHeader /> : null}
    </View>
  );

  const clear = () => setView({ status: undefined, dl: false, len: undefined });
  const empty = whole.isLoading ? (
    booksLayout === 'grid' ? (
      <CoverGridSkeleton rows={3} gutter={0} />
    ) : (
      <RowSkeletonList count={6} />
    )
  ) : whole.error && total === 0 ? (
    <LoadError
      title={t('library.books.error.title')}
      hint={t('library.books.error.hint')}
      retryLabel={t('common.retry')}
      onRetry={whole.retry}
    />
  ) : total === 0 ? (
    <EmptyState
      variant="card"
      art={<GhostSpines />}
      title={t('library.books.empty.title', { library: libraryName })}
      hint={t('library.books.empty.hint')}
      action={{ label: t('library.books.empty.action'), onPress: whole.refresh }}
    />
  ) : whole.complete ? (
    <EmptyState
      variant="card"
      art={<GhostCovers />}
      title={t('library.books.noMatches.title')}
      hint={t('library.books.noMatches.hint')}
      action={{ label: t('library.books.noMatches.action'), onPress: clear }}
    />
  ) : null;

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
        keyExtractor={itemKey}
        isFullRow={(item) => item.kind === 'head'}
        renderItem={(item, tile) =>
          item.kind === 'head' ? (
            renderHead(item.letter)
          ) : (
            <BookTile
              connectionId={connectionId}
              libraryId={libraryId}
              book={item.item}
              progress={progressOf(item.item)}
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
        gutter={gutter}
        renderHead={renderHead}
        renderBook={(book) => (
          <BookListRow
            connectionId={connectionId}
            libraryId={libraryId}
            book={book}
            progress={progressOf(book)}
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
        <View className="flex-1">{body}</View>
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
  gutter,
  renderHead,
  renderBook,
  header,
  empty,
  footer,
}: {
  listRef: React.Ref<FlashListRef<BooksGridItem>>;
  items: BooksGridItem[];
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
      keyExtractor={itemKey}
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
