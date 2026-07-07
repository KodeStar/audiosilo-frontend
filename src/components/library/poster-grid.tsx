import { type ReactNode } from 'react';
import { View } from 'react-native';

import { useApi } from '@/api/provider';
import { DownloadBadge } from '@/components/library/download-badge';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';

// Grid sizing: pick as many columns as fit at a comfortable minimum card width,
// then divide the measured row width evenly (numeric widths avoid the flex-gap
// overflow that percentage widths hit on native). Shared by the home screen and
// the Favourites screen so book cards look identical everywhere.
export const GRID_GAP = 12;
const MIN_CARD_WIDTH = 220;

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

/**
 * Frames cover art so dark covers separate from dark surfaces: a hairline border
 * on both themes plus a soft shadow in light mode only (the house "shadow light /
 * border dark" pattern). Wrap every cover in this for consistent treatment.
 */
export function CoverFrame({ children }: { children: ReactNode }) {
  return (
    <View className="overflow-hidden rounded-lg border border-black/10 shadow-sm dark:border-white/10 dark:shadow-none">
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
  /** The book's source connection; opening routes into that server's scope. Every
   * GridCard comes from a connection-tagged list, so this is always known. */
  connectionId: string;
}) {
  const api = useApi(connectionId);
  const { openBook } = useOpen();
  // Width is a numeric layout value, so it rides on a plain wrapper View - passing
  // a `style` to AnimatedPressable would clobber its internal press-scale style.
  return (
    <View style={{ width }}>
      <AnimatedPressable
        onPress={() => openBook(connectionId, libraryId, path)}
        accessibilityRole="button"
        className="w-full gap-2.5 rounded-xl border border-gray-200 bg-gray-50 p-3 hover:bg-gray-100 dark:border-gray-860 dark:bg-gray-840 dark:hover:bg-gray-800"
      >
        <CoverFrame>
          <Cover
            source={{ uri: api.coverUrl(libraryId, path), headers: api.authHeaders() }}
            label={title}
            sublabel={author}
            rounded="rounded-none"
          />
        </CoverFrame>
        <View className="flex-row items-start gap-1.5">
          <View className="h-10 flex-1 justify-start">
            <Text variant="subtitle" numberOfLines={2}>
              {title}
            </Text>
          </View>
          <View className="pt-0.5">
            <DownloadBadge connectionId={connectionId} libraryId={libraryId} path={path} />
          </View>
        </View>
        {footer}
      </AnimatedPressable>
    </View>
  );
}

/** Loading placeholder shaped like a GridCard: a cover-square skeleton and two
 * text lines, so a loading shelf/grid mirrors the final layout instead of a
 * spinner. `footer` adds an extra line (e.g. the progress row on Continue). */
export function GridCardSkeleton({ width, footer }: { width: number; footer?: boolean }) {
  return (
    <View style={{ width }}>
      <View className="w-full gap-2.5 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-860 dark:bg-gray-840">
        <Skeleton className="aspect-square w-full rounded-lg" />
        <View className="gap-2 py-0.5">
          <Skeleton className="h-3.5 w-full rounded" />
          <Skeleton className="h-3.5 w-2/3 rounded" />
        </View>
        {footer ? <Skeleton className="h-1.5 w-full rounded-full" /> : null}
      </View>
    </View>
  );
}
