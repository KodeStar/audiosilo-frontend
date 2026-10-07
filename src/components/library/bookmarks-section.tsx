import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useBookmarks, useDeleteBookmark } from '@/api/hooks';
import { useCid } from '@/api/provider';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { RowSurface } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

// Quiet row surface shared by the section's list items.

/** Bookmarks for a book: tap to jump in the player, trash to delete.
 *
 * Inline on the book screen it renders nothing when empty. The player's companion
 * passes `addButton`/`emptyLabel` so it stays visible - its "add at the current
 * position" button (its own leaf: its label follows the playhead) plus a placeholder -
 * giving a way to both create and see bookmarks. */
export function BookmarksSection({
  libraryId,
  path,
  connectionId,
  emptyLabel,
  addButton,
  onJump,
}: {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one (the book screen). The player
   * passes the playing book's connection so it addresses the right server. */
  connectionId?: string;
  emptyLabel?: string;
  /** Leads the list (the companion's "Add bookmark at 1:16:19"). */
  addButton?: ReactNode;
  /** Where a tap on a bookmark goes. The player's companion seeks the playing book in
   * place (a jump, so the Undo chip follows); without it a tap opens the player there. */
  onJump?: (position: number) => void;
}) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const { data: bookmarks } = useBookmarks(libraryId, path, connectionId);
  const del = useDeleteBookmark(libraryId, path, connectionId);
  // The book this bookmark belongs to: the passed connection (player sheet) or the
  // route scope (book screen). The player carries it as a param.
  const cid = useCid(connectionId);

  const empty = !bookmarks || bookmarks.length === 0;
  if (empty && !addButton && !emptyLabel) return null;

  const jump = (position: number) => {
    if (onJump) return onJump(position);
    router.push({
      pathname: '/player',
      params: { connection: cid, libraryId: String(libraryId), path, position: String(position) },
    });
  };

  return (
    <View className="gap-2">
      {addButton}
      {empty && emptyLabel ? (
        <EmptyState icon="bookmark" title={emptyLabel} className="py-6" />
      ) : null}
      {(bookmarks ?? []).map((bm) => (
        <RowSurface key={bm.id} className="flex-row items-center gap-3 p-3">
          <AnimatedPressable
            className="flex-1 flex-row items-center gap-3"
            accessibilityRole="button"
            onPress={() => void jump(bm.position)}
          >
            <Icon name="bookmark" size={16} color={themed.brand} />
            <View className="flex-1">
              <Text variant="label" style={tabularNums}>
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
            <Icon name="trash" size={16} color={themed.destructive} />
          </AnimatedPressable>
        </RowSurface>
      ))}
    </View>
  );
}
