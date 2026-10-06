import { FlashList } from '@shopify/flash-list';
import { type ReactElement, useState } from 'react';
import { View } from 'react-native';

import { pageGutter } from '@/components/library/cover-layout';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Text } from '@/components/ui/text';
import { type LayoutClass, useLayout } from '@/lib/layout';

import { groupByLetter, LETTER_HEADS_MIN } from './people-model';

/** Columns and card width for an inner `width`: as many cards of at least `min` as fit
 * (`phone` is how many a phone gets: one wide card, or two). */
export function cardGridMetrics(
  width: number,
  layout: LayoutClass,
  min: number,
  phone: 1 | 2,
): { columns: number; card: number; gap: number } {
  const gap = layout === 'phone' ? 12 : 18;
  const columns = layout === 'phone' ? phone : Math.max(1, Math.floor((width + gap) / (min + gap)));
  return { columns, card: Math.max(0, Math.floor((width - gap * (columns - 1)) / columns)), gap };
}

type Row<T> = { kind: 'head'; letter: string } | { kind: 'row'; key: string; items: T[] };

/** The list as rows of `columns` cards, under A-Z heads when it is long (`name` given). */
export function cardRows<T>(
  data: readonly T[],
  columns: number,
  keyOf: (item: T) => string,
  name?: (item: T) => string,
): Row<T>[] {
  const chunk = (items: readonly T[]): Row<T>[] => {
    const out: Row<T>[] = [];
    for (let i = 0; i < items.length; i += columns) {
      const slice = items.slice(i, i + columns);
      out.push({ kind: 'row', key: keyOf(slice[0]), items: slice });
    }
    return out;
  };
  if (!name || data.length <= LETTER_HEADS_MIN) return chunk(data);
  return groupByLetter(data, name).flatMap((g) => [
    { kind: 'head' as const, letter: g.letter },
    ...chunk(g.items),
  ]);
}

/**
 * A page of cards for the Library's Series, Authors and Narrators modes, on FlashList:
 * rows of equal cards (at least `minWidth` wide, `phoneColumns` on a phone), under A-Z
 * heads when a long list is named (`name`). It is the page's scroller, like `CoverGrid`,
 * which it doesn't reuse because its tiles are covers at cover sizes and its rows can't
 * carry a head that spans them. Only the rows on screen render, so a card that fetches
 * (its mini shelf, its cover fan) fetches only once it is visible.
 */
export function CardGrid<T>({
  data,
  keyExtractor,
  renderItem,
  minWidth,
  phoneColumns = 1,
  name,
  ListHeaderComponent,
  ListFooterComponent,
  testID = 'card-grid',
}: {
  data: readonly T[];
  keyExtractor: (item: T) => string;
  renderItem: (item: T, width: number) => ReactElement;
  minWidth: number;
  phoneColumns?: 1 | 2;
  name?: (item: T) => string;
  ListHeaderComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
  testID?: string;
}) {
  const layout = useLayout();
  const pad = pageGutter(layout);
  const [width, setWidth] = useState(0);
  const { columns, card, gap } = cardGridMetrics(
    Math.max(0, width - pad * 2),
    layout,
    minWidth,
    phoneColumns,
  );
  const paddingBottom = useMiniPlayerInset();
  const rows = cardRows(data, columns, keyExtractor, name);
  return (
    <View testID={testID} className="flex-1" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <FlashList
          key={columns}
          data={rows}
          keyExtractor={(r) => (r.kind === 'head' ? `#${r.letter}` : r.key)}
          getItemType={(r) => r.kind}
          renderItem={({ item: r }) =>
            r.kind === 'head' ? (
              <Text
                variant="heading"
                accessibilityRole="header"
                className="pb-2.5 pt-1"
                style={{ paddingHorizontal: pad }}
              >
                {r.letter}
              </Text>
            ) : (
              <View
                className="flex-row"
                style={{ gap, paddingHorizontal: pad, paddingBottom: gap }}
              >
                {r.items.map((it) => (
                  <View key={keyExtractor(it)} style={{ width: card }}>
                    {renderItem(it, card)}
                  </View>
                ))}
              </View>
            )
          }
          ListHeaderComponent={ListHeaderComponent}
          ListFooterComponent={ListFooterComponent}
          contentContainerStyle={{ paddingTop: layout === 'phone' ? 8 : 20, paddingBottom }}
        />
      ) : null}
    </View>
  );
}
