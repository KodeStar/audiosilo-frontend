import { type ReactElement, useMemo } from 'react';
import { View } from 'react-native';

import { CoverGrid } from '@/components/library/cover-grid';
import { cardGrid, gridMetrics } from '@/components/library/cover-layout';
import { Text } from '@/components/ui/text';
import { type LetterItem, letterItems } from '@/lib/alpha-sections';
import { useLayout } from '@/lib/layout';

import { LETTER_HEADS_MIN } from './people-model';

/** The list as grid items, under A-Z heads when it is long (`name` given). */
export function cardItems<T>(data: readonly T[], name?: (item: T) => string): LetterItem<T>[] {
  if (!name || data.length <= LETTER_HEADS_MIN) {
    return data.map((item) => ({ kind: 'item', item }));
  }
  return letterItems(data, name).items;
}

/**
 * A page of cards for the Library's Series, Authors and Narrators modes: a `CoverGrid`
 * of equal cards (at least `minWidth` wide, `phoneColumns` on a phone), under A-Z heads
 * when a long list is named (`name`). Only the rows on screen render, so a card that
 * fetches (its mini shelf, its cover fan) fetches only once it is visible.
 */
export function CardGrid<T>({
  data,
  keyExtractor,
  renderItem,
  minWidth,
  phoneColumns = 1,
  name,
  ListFooterComponent,
  testID = 'card-grid',
}: {
  data: readonly T[];
  keyExtractor: (item: T) => string;
  renderItem: (item: T, width: number) => ReactElement;
  minWidth: number;
  phoneColumns?: 1 | 2;
  name?: (item: T) => string;
  ListFooterComponent?: ReactElement | null;
  testID?: string;
}) {
  const layout = useLayout();
  const spec = useMemo(() => cardGrid(minWidth, phoneColumns), [minWidth, phoneColumns]);
  const items = useMemo(() => cardItems(data, name), [data, name]);
  // A head sits on the row gap the grid gives every row; its own padding is the gap.
  const { rowGap } = gridMetrics(0, layout, spec);
  return (
    <CoverGrid
      testID={testID}
      data={items}
      spec={spec}
      paddingTop={layout === 'phone' ? 8 : 20}
      keyExtractor={(it) => (it.kind === 'head' ? `#${it.letter}` : keyExtractor(it.item))}
      isFullRow={(it) => it.kind === 'head'}
      renderItem={(it, width) =>
        it.kind === 'head' ? (
          <View style={{ marginBottom: -rowGap }}>
            <Text variant="heading" accessibilityRole="header" className="pb-2.5 pt-1">
              {it.letter}
            </Text>
          </View>
        ) : (
          renderItem(it.item, width)
        )
      }
      ListFooterComponent={ListFooterComponent}
    />
  );
}
