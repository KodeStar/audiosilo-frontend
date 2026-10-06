import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import { type ReactElement, type Ref, useState } from 'react';
import { View } from 'react-native';

import { useMiniPlayerInset } from '@/components/player/mini-player';
import { PressableRow, RowSurface } from '@/components/ui/row-surface';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';

import { BookCover } from './book-cover';
import { type GridSpec, gridMetrics, pageGutter } from './cover-layout';

type PassThrough<T> = Pick<
  FlashListProps<T>,
  'onEndReached' | 'onEndReachedThreshold' | 'onScroll' | 'refreshControl'
>;

/**
 * A page's grid of cover tiles on FlashList (STYLEGUIDE section 5: `repeat(auto-fill,
 * minmax(158px, 1fr))`, two columns on a phone): it measures its own width and divides
 * it (`gridMetrics`, by `spec`: covers by default, `cardGrid` for cards), handing
 * `renderItem` the tile width - give it a `CoverTile`. It IS the page's scroller: put the
 * page's header (chips, counts) in `ListHeaderComponent`, which spans every column and,
 * like the empty state and the footer, lines up with the tiles. Padded by the page
 * gutter, and clear of the phone's mini player at the bottom. A full-width row inside the
 * grid (a letter head, `isFullRow`) takes every column; `listRef` scrolls it (an A-Z
 * rail's jump).
 */
export function CoverGrid<T>({
  data,
  keyExtractor,
  renderItem,
  gutter,
  spec,
  isFullRow,
  paddingTop = 4,
  listRef,
  ListHeaderComponent,
  ListEmptyComponent,
  ListFooterComponent,
  testID = 'cover-grid',
  ...rest
}: {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T, tileWidth: number) => ReactElement;
  gutter?: number;
  spec?: GridSpec;
  isFullRow?: (item: T) => boolean;
  paddingTop?: number;
  listRef?: Ref<FlashListRef<T>>;
  ListHeaderComponent?: ReactElement | null;
  ListEmptyComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
  testID?: string;
} & PassThrough<T>) {
  const layout = useLayout();
  const pad = gutter ?? pageGutter(layout);
  const [width, setWidth] = useState(0);
  const { columns, tile, columnGap, rowGap } = gridMetrics(
    Math.max(0, width - pad * 2),
    layout,
    spec,
  );
  const paddingBottom = useMiniPlayerInset();
  // The content is padded by the gutter less half a column gap (each tile carries the
  // other half), so what spans the grid puts that half back to line up with the tiles.
  const inset = (node: ReactElement | null | undefined) =>
    node ? <View style={{ paddingHorizontal: columnGap / 2 }}>{node}</View> : null;
  return (
    <View testID={testID} className="flex-1" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <FlashList
          // A new column count re-lays the whole list.
          key={columns}
          ref={listRef}
          data={data}
          numColumns={columns}
          keyExtractor={keyExtractor}
          renderItem={({ item }) => (
            <View style={{ paddingHorizontal: columnGap / 2, paddingBottom: rowGap }}>
              {renderItem(item, tile)}
            </View>
          )}
          {...(isFullRow
            ? {
                getItemType: (item: T) => (isFullRow(item) ? 'row' : 'tile'),
                overrideItemLayout: (l: { span?: number }, item: T, _i: number, max: number) => {
                  if (isFullRow(item)) l.span = max;
                },
              }
            : {})}
          ListHeaderComponent={inset(ListHeaderComponent)}
          ListEmptyComponent={inset(ListEmptyComponent)}
          ListFooterComponent={inset(ListFooterComponent)}
          contentContainerStyle={{
            paddingHorizontal: pad - columnGap / 2,
            paddingTop,
            paddingBottom,
          }}
          {...rest}
        />
      ) : null}
    </View>
  );
}

/**
 * The loading state of a `CoverGrid` (or of a grid section): the same columns and tile
 * width, each an exact cover-shaped placeholder with its two text lines, so nothing
 * shifts when the books arrive (STYLEGUIDE section 8: skeletons). `rows` of them.
 */
export function CoverGridSkeleton({ rows = 2, gutter }: { rows?: number; gutter?: number }) {
  const layout = useLayout();
  const pad = gutter ?? pageGutter(layout);
  const [width, setWidth] = useState(0);
  const { columns, tile, columnGap, rowGap } = gridMetrics(Math.max(0, width - pad * 2), layout);
  return (
    <View
      testID="cover-grid-skeleton"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      className="flex-row flex-wrap"
      style={{ paddingHorizontal: pad, paddingTop: 4, columnGap, rowGap }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {width > 0
        ? Array.from({ length: columns * rows }).map((_, i) => (
            <CoverTileSkeleton key={i} width={tile} />
          ))
        : null}
    </View>
  );
}

/** One placeholder tile: the square cover and the title and caption lines. */
export function CoverTileSkeleton({ width }: { width: number }) {
  return (
    <View style={{ width }} className="gap-2.5">
      <View style={{ width, height: width }}>
        <Skeleton className="h-full w-full rounded-cover" testID="cover-skeleton" />
      </View>
      <View className="gap-1.5 py-0.5">
        <Skeleton className="h-3.5 w-11/12 rounded-sm" />
        <Skeleton className="h-3 w-2/3 rounded-sm" />
      </View>
    </View>
  );
}

/**
 * The list variant of a book for a grid/list toggle: a quiet row (`PressableRow`) with a
 * 48 cover, the title, one subtitle line, optional `aside` columns inside the row
 * (narrator, length, progress: text only, nothing pressable), and an optional trailing
 * slot (a menu button: keep any button in it a sibling of the row's own press, never
 * nested). The surface wraps both, so the trailing button sits inside the row's card,
 * not in a gutter beside it; the press covers the rest of the card.
 */
export function CoverListRow({
  connectionId,
  libraryId,
  path,
  title,
  subtitle,
  author,
  coverVersion,
  onPress,
  aside,
  trailing,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  title: string;
  subtitle?: string;
  author?: string;
  coverVersion?: string;
  onPress: () => void;
  aside?: ReactElement | null;
  trailing?: ReactElement | null;
}) {
  return (
    <RowSurface testID="cover-list-row" className="my-1 flex-row items-center pr-1">
      <PressableRow
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')}
        // The surface is the wrapper's; the press keeps only its hover/pressed fill.
        className="min-h-[64px] flex-1 flex-row items-center gap-3 border-0 bg-transparent px-2 py-2"
      >
        <BookCover
          connectionId={connectionId}
          libraryId={libraryId}
          path={path}
          coverVersion={coverVersion}
          width={48}
          title={title}
          author={author}
        />
        <View className="flex-1 gap-0.5">
          <Text variant="label" numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {aside ?? null}
      </PressableRow>
      {trailing ?? null}
    </RowSurface>
  );
}
