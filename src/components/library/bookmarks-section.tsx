import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useBookmarks, useDeleteBookmark } from '@/api/hooks';
import { useCid } from '@/api/provider';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { colors } from '@/theme/tokens';

/** Bookmarks for a book: tap to jump in the player, trash to delete.
 *
 * Inline on the book screen it renders nothing when empty. The player sheet
 * passes `onAdd`/`emptyLabel` so it stays visible - an "add at current position"
 * button plus a placeholder - giving a way to both create and see bookmarks. */
export function BookmarksSection({
  libraryId,
  path,
  connectionId,
  emptyLabel,
  onAdd,
  adding,
  addLabel,
}: {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one (the book screen). The player
   * passes the playing book's connection so it addresses the right server. */
  connectionId?: string;
  emptyLabel?: string;
  onAdd?: () => void;
  adding?: boolean;
  addLabel?: string;
}) {
  const { t } = useTranslation();
  const { data: bookmarks } = useBookmarks(libraryId, path, connectionId);
  const del = useDeleteBookmark(libraryId, path, connectionId);
  // The book this bookmark belongs to: the passed connection (player sheet) or the
  // route scope (book screen). The player carries it as a param.
  const cid = useCid(connectionId);

  const empty = !bookmarks || bookmarks.length === 0;
  if (empty && !onAdd && !emptyLabel) return null;

  const jump = (position: number) => {
    router.push({
      pathname: '/player',
      params: { connectionId: cid, libraryId: String(libraryId), path, position: String(position) },
    });
  };

  return (
    <View className="gap-2">
      <Text variant="title">{t('library.bookmarks.title')}</Text>
      {onAdd ? (
        <Button
          title={addLabel ?? t('library.bookmarks.add')}
          icon="bookmark"
          onPress={onAdd}
          loading={adding}
        />
      ) : null}
      {empty && emptyLabel ? <Text variant="caption">{emptyLabel}</Text> : null}
      {(bookmarks ?? []).map((bm) => (
        <View
          key={bm.id}
          className="flex-row items-center gap-3 rounded-lg bg-white p-3 dark:border dark:border-gray-860 dark:bg-gray-840"
        >
          <Pressable
            className="flex-1 flex-row items-center gap-3"
            onPress={() => void jump(bm.position)}
          >
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
