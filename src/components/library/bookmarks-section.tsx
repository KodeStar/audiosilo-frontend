import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useBookmarks, useDeleteBookmark } from '@/api/hooks';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { colors } from '@/theme/tokens';

/** Bookmarks for a book: tap to jump in the player, trash to delete. Renders
 * nothing when there are none. */
export function BookmarksSection({ libraryId, path }: { libraryId: number; path: string }) {
  const { data: bookmarks } = useBookmarks(libraryId, path);
  const del = useDeleteBookmark(libraryId, path);

  if (!bookmarks || bookmarks.length === 0) return null;

  const jump = (position: number) =>
    router.push({
      pathname: '/player',
      params: { libraryId: String(libraryId), path, position: String(position) },
    });

  return (
    <View className="gap-2">
      <Text variant="title">Bookmarks</Text>
      {bookmarks.map((bm) => (
        <View
          key={bm.id}
          className="flex-row items-center gap-3 rounded-lg bg-white p-3 dark:border dark:border-gray-860 dark:bg-gray-840"
        >
          <Pressable className="flex-1 flex-row items-center gap-3" onPress={() => jump(bm.position)}>
            <Icon name="bookmark" size={16} color={colors.primary} />
            <View className="flex-1">
              <Text variant="subtitle">{formatClock(bm.position)}</Text>
              {bm.note ? (
                <Text variant="muted" numberOfLines={1}>
                  {bm.note}
                </Text>
              ) : null}
            </View>
          </Pressable>
          <Pressable
            onPress={() => del.mutate(bm.id)}
            hitSlop={8}
            className="h-8 w-8 items-center justify-center"
          >
            <Icon name="trash" size={16} color={colors.dark.textMuted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}
