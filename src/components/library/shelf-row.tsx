import { FlashList } from '@shopify/flash-list';
import { type ReactElement } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useLayout } from '@/lib/layout';
import { useThemeColors } from '@/theme/use-theme-colors';
import { useDomId } from '@/lib/use-dom-id';

import { pageGutter, shelfMetrics } from './cover-layout';

/** Space above the covers (room for the press scale) and so where the ledge starts. */
const TOP = 6;
const LEDGE = 8;
const LEDGE_SHADOW = 12;

/**
 * The shelf the covers stand on (STYLEGUIDE section 8, "Shelf row with ledge"): an 8px
 * plank in `shelf-edge` with a light top edge and a darker foot, and a soft shadow under
 * it. Decorative.
 */
export function Ledge({ top }: { top: number }) {
  const themed = useThemeColors();
  const id = useDomId('ledge');
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', left: 0, right: 0, top }}
    >
      <View
        className="border-b-2 border-t border-b-foreground/10 border-t-card/70 bg-shelf-edge"
        style={{ height: LEDGE }}
      />
      <Svg width="100%" height={LEDGE_SHADOW}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} stopColor={themed.shelfShadow} />
            <Stop offset={1} stopColor={themed.shelfShadow} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={LEDGE_SHADOW} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/**
 * A horizontal, snap-scrolling row of cover tiles standing on a shelf ledge (STYLEGUIDE
 * section 8), on FlashList. Tiles are 164 wide (132 on a phone); `renderItem` gets the
 * tile width - give it a `CoverTile` with `onShelf` (its titles hang below the ledge) or
 * a `GhostCover`. The row bleeds to the window edge past the page's own padding
 * (`gutter`, the page gutter by default), so pass the gutter of the page it sits in.
 * The ledge is drawn behind the scroller directly under the covers, so it stays put
 * while the covers scroll over it.
 */
export function ShelfRow<T>({
  data,
  keyExtractor,
  renderItem,
  gutter,
  ledge = true,
  accessibilityLabel,
}: {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T, tileWidth: number) => ReactElement;
  /** The page padding to bleed past (defaults to the page gutter of this form factor). */
  gutter?: number;
  /** Draw the ledge (a plain scroller of covers without). */
  ledge?: boolean;
  /** Names the row for assistive tech (usually the shelf's heading). */
  accessibilityLabel?: string;
}) {
  const layout = useLayout();
  const { tile, gap } = shelfMetrics(layout);
  const pad = gutter ?? pageGutter(layout);
  return (
    <View style={{ marginHorizontal: -pad }} accessibilityLabel={accessibilityLabel}>
      {ledge ? <Ledge top={TOP + tile} /> : null}
      <FlashList
        horizontal
        data={data}
        keyExtractor={keyExtractor}
        renderItem={({ item }) => renderItem(item, tile)}
        ItemSeparatorComponent={() => <View style={{ width: gap }} />}
        showsHorizontalScrollIndicator={false}
        snapToInterval={tile + gap}
        snapToAlignment="start"
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: pad, paddingTop: TOP, paddingBottom: 4 }}
      />
    </View>
  );
}
