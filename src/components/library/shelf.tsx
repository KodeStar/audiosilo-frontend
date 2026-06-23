import { type ReactElement } from 'react';
import { FlatList } from 'react-native';

/** Card width for the phone home shelves. */
export const SHELF_CARD_WIDTH = 152;
const SHELF_GAP = 12;

/**
 * A horizontal, virtualized row of cards for the phone home shelves. The cards
 * are full-bleed: the `-16` horizontal margin cancels the home ScrollView's `p-4`
 * so the row scrolls edge-to-edge, with the `16` content padding giving the first
 * and last card a comfortable inset.
 */
export function HorizontalShelf<T>({
  data,
  keyExtractor,
  renderCard,
}: {
  data: T[];
  keyExtractor: (item: T) => string;
  renderCard: (item: T) => ReactElement;
}) {
  return (
    <FlatList
      horizontal
      data={data}
      keyExtractor={keyExtractor}
      renderItem={({ item }) => renderCard(item)}
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -16 }}
      contentContainerStyle={{ gap: SHELF_GAP, paddingHorizontal: 16 }}
    />
  );
}
