import { Pressable, View } from 'react-native';

import { useFavourites, useToggleFavourite } from '@/api/hooks';
import type { Book } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatBytes, formatDuration } from '@/lib/format';
import { colors } from '@/theme/tokens';

// A fixed-height top slot keeps the heart icon and the value text on the same
// baseline so every column's label sits on one line.
const topSlot = 'h-8 items-center justify-center';

/** A single value-over-label stat column. */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View className="flex-1 items-center gap-1 px-2">
      <View className={topSlot}>
        <Text variant="heading" numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Text variant="muted" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function Divider() {
  return <View className="my-1 w-px self-stretch bg-gray-200 dark:bg-gray-750" />;
}

/**
 * The three-up stat strip on the book overview: a favourite toggle, the download
 * size over its format, and the total length — split by hairline dividers and
 * spread across the full width. Shared by the phone and wide (detail-panel)
 * overviews so they stay consistent.
 */
export function BookStats({
  libraryId,
  path,
  book,
}: {
  libraryId: number;
  path: string;
  book: Book;
}) {
  const { data: favourites } = useFavourites();
  const toggleFavourite = useToggleFavourite();
  const isFavourite = !!favourites?.some((f) => f.library_id === libraryId && f.path === path);

  return (
    <View className="w-full flex-row items-stretch rounded-lg border border-gray-200 bg-gray-100 py-4 dark:border-gray-750 dark:bg-gray-840">
      <Pressable
        onPress={() => toggleFavourite.mutate({ libraryId, path, on: !isFavourite })}
        accessibilityRole="button"
        accessibilityLabel={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
        className="flex-1 items-center gap-1 px-2 active:opacity-60"
      >
        <View className={topSlot}>
          <Icon
            name={isFavourite ? 'heart-solid' : 'heart'}
            size={24}
            color={isFavourite ? colors.primary : undefined}
          />
        </View>
        <Text variant="muted">Favourite</Text>
      </Pressable>

      <Divider />
      <Stat value={formatBytes(book.size)} label={book.format?.toUpperCase() || 'Audio'} />

      <Divider />
      <Stat value={formatDuration(book.duration)} label="length" />
    </View>
  );
}
