import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useBookmarks, useDeleteBookmark } from '@/api/hooks';
import { useCid } from '@/api/provider';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { colors, tabularNums } from '@/theme/tokens';

// Quiet row surface shared by the section's list items.
const ROW =
  'flex-row items-center gap-3 rounded-xl bg-white p-3 shadow-sm dark:border dark:border-gray-750 dark:bg-gray-840 dark:shadow-none';

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
      params: { connection: cid, libraryId: String(libraryId), path, position: String(position) },
    });
  };

  return (
    <View className="gap-2">
      <SectionHeader title={t('library.bookmarks.title')} />
      {onAdd ? (
        <Button
          title={addLabel ?? t('library.bookmarks.add')}
          icon="bookmark"
          onPress={onAdd}
          loading={adding}
        />
      ) : null}
      {empty && emptyLabel ? (
        <EmptyState icon="bookmark" title={emptyLabel} className="py-6" />
      ) : null}
      {(bookmarks ?? []).map((bm) => (
        <View key={bm.id} className={ROW}>
          <AnimatedPressable
            className="flex-1 flex-row items-center gap-3"
            accessibilityRole="button"
            onPress={() => void jump(bm.position)}
          >
            <Icon name="bookmark" size={16} color={colors.primary} />
            <View className="flex-1">
              <Text variant="subtitle" style={tabularNums}>
                {formatClock(bm.position)}
              </Text>
              {bm.note ? (
                <Text variant="muted" numberOfLines={1}>
                  {bm.note}
                </Text>
              ) : null}
            </View>
          </AnimatedPressable>
          <AnimatedPressable
            onPress={() => del.mutate(bm.id)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('library.bookmarks.delete')}
            className="h-8 w-8 items-center justify-center"
          >
            <Icon name="trash" size={16} color={colors.danger} />
          </AnimatedPressable>
        </View>
      ))}
    </View>
  );
}
