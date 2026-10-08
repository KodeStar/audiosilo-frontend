import { FlashList } from '@shopify/flash-list';
import { type ReactElement, useMemo } from 'react';
import { View } from 'react-native';

import { useLayout } from '@/lib/layout';

import { pageGutter, shelfMetrics } from './cover-layout';

/** Space above the covers (room for the press scale). */
const TOP = 6;

function gapSeparator(width: number) {
  const Gap = () => <View style={{ width }} />;
  Gap.displayName = 'ShelfGap';
  return Gap;
}

/**
 * A horizontal, snap-scrolling row of cover tiles (STYLEGUIDE section 8), on FlashList.
 * Tiles are 164 wide (132 on a phone); `renderItem` gets the tile width - give it a
 * `CoverTile` or a `GhostCover`. The row bleeds to the window edge past the page gutter.
 */
export function ShelfRow<T>({
  data,
  keyExtractor,
  renderItem,
  accessibilityLabel,
}: {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T, tileWidth: number) => ReactElement;
  /** Names the row for assistive tech (usually the shelf's heading). */
  accessibilityLabel?: string;
}) {
  const layout = useLayout();
  const { tile, gap } = shelfMetrics(layout);
  const pad = pageGutter(layout);
  // One separator type per gap: an inline component would be a new type each render,
  // which remounts every separator.
  const Separator = useMemo(() => gapSeparator(gap), [gap]);
  return (
    <View style={{ marginHorizontal: -pad }} accessibilityLabel={accessibilityLabel}>
      <FlashList
        horizontal
        data={data}
        keyExtractor={keyExtractor}
        renderItem={({ item }) => renderItem(item, tile)}
        ItemSeparatorComponent={Separator}
        showsHorizontalScrollIndicator={false}
        snapToInterval={tile + gap}
        snapToAlignment="start"
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: pad, paddingTop: TOP, paddingBottom: 4 }}
      />
    </View>
  );
}
