import { router } from 'expo-router';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useApi } from '@/api/provider';
import { DownloadBadge } from '@/components/library/download-badge';
import { Cover } from '@/components/ui/cover';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
import { bookHref } from '@/lib/paths';

// Grid sizing: pick as many columns as fit at a comfortable minimum card width,
// then divide the measured row width evenly (numeric widths avoid the flex-gap
// overflow that percentage widths hit on native). Shared by the home screen and
// the Favourites screen so book cards look identical everywhere.
export const GRID_GAP = 12;
export const MIN_CARD_WIDTH = 220;

export function gridColumns(width: number) {
  return Math.max(2, Math.floor((width + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)));
}

export function Grid({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap" style={{ gap: GRID_GAP }}>
      {children}
    </View>
  );
}

/** A poster-style grid cell: square cover, title (with the download badge), and
 * an optional footer (e.g. a progress bar). Tapping opens the book screen. */
export function GridCard({
  libraryId,
  path,
  title,
  author,
  width,
  footer,
  connectionId,
}: {
  libraryId: number;
  path: string;
  author?: string;
  title: string;
  width: number;
  footer?: ReactNode;
  /** Source connection; when set, opening switches to it first (cross-server). */
  connectionId?: string;
}) {
  const api = useApi(connectionId);
  const { openBook } = useOpen();
  return (
    <Pressable
      onPress={() =>
        connectionId
          ? void openBook(connectionId, libraryId, path)
          : router.push(bookHref(libraryId, path))
      }
      style={{ width }}
      className="gap-2 rounded-lg border p-4 border-gray-200 bg-gray-50 shadow-sm dark:border-gray-860 dark:bg-gray-840 dark:shadow-none active:opacity-80"
    >
      <Cover
        source={{ uri: api.coverUrl(libraryId, path), headers: api.authHeaders() }}
        label={title}
        sublabel={author}
        rounded="rounded-lg"
      />
      <View className="flex-row items-start gap-1.5">
        <View className="h-10 flex-1 justify-center">
          <Text variant="subtitle" numberOfLines={2}>
            {title}
          </Text>
        </View>
        <View className="pt-0.5">
          <DownloadBadge libraryId={libraryId} path={path} />
        </View>
      </View>
      {footer}
    </Pressable>
  );
}
