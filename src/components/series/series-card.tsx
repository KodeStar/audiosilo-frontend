import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import type { SeriesCount } from '@/api/types';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { MiniShelf, MiniShelfSkeleton } from './mini-shelf';
import { localEntries, localGaps, type ProgressLookup } from './series-model';
import { useSeriesBooks } from './use-series-data';

const SHELF = 118;

const CARD = cn(
  'gap-3.5 rounded-[20px] border border-border bg-card px-[18px] pb-4 pt-[18px]',
  Platform.select({
    web: `cursor-pointer transition-colors hover:border-border-strong ${FOCUS_RING_OFFSET_CLASS}`,
  }),
);

/** The positions a series' shelf holds, gaps included, for its loading spines. */
function shelfPositions(positions: readonly number[]): number[] {
  return [...positions, ...localGaps(positions)].sort((a, b) => a - b);
}

/**
 * A series in the Library's Series mode: a mini shelf of the listener's spines (with
 * dashed ghosts for the numbers they skip), the name, the author and length, and where
 * they are ("4 of 7 · 1 in progress"). Its books are fetched when the card first shows
 * (the grid renders only the rows on screen), so a library of 300 series asks for the
 * few on screen, not all of them; on a server with `series_books` the cards that show
 * together are asked for in one request (`useSeriesBooks` with `batch` ->
 * `seriesBooksPage`), else one per card. Until then the shelf is spine-shaped placeholders at the positions the
 * series list already gives.
 *
 * Search shows its series results with it too: `heading` replaces the plain name (the
 * match in bold), `kindLabel` names it a series to a screen reader, `where` adds the
 * server line ("Hearthside · Also on Maya's Shelf") and `onOpened` runs before it opens.
 */
export function SeriesCard({
  series,
  connectionId,
  connectionName,
  libraryId,
  progressOf,
  heading,
  kindLabel,
  where,
  onOpened,
}: {
  series: SeriesCount;
  connectionId: string;
  connectionName: string;
  libraryId: number;
  progressOf: ProgressLookup;
  heading?: ReactNode;
  kindLabel?: string;
  where?: string;
  onOpened?: () => void;
}) {
  const { t } = useTranslation();
  const { openSeries } = useOpen();
  const { books } = useSeriesBooks(libraryId, series.name, connectionId, { batch: true });
  const entries =
    books.length > 0 ? localEntries(books, { connectionId, connectionName, progressOf }) : null;
  const gaps = localGaps(series.positions).length;
  const average = series.books > 0 ? series.duration / series.books : undefined;
  const inProgress = entries?.filter((e) => e.started && !e.finished).length ?? 0;
  const finished = entries?.filter((e) => e.finished).length ?? 0;
  const summary = [
    gaps > 0
      ? t('series.mode.ofTotal', { owned: series.books, total: series.books + gaps })
      : t('series.mode.books', { count: series.books }),
    inProgress ? t('series.mode.inProgress', { count: inProgress }) : '',
    finished ? t('series.mode.finished', { count: finished }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const byline = [series.author, formatDuration(series.duration)].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={() => {
        onOpened?.();
        openSeries(connectionId, libraryId, { name: series.name });
      }}
      accessibilityRole="button"
      accessibilityLabel={[series.name, kindLabel, byline, summary, where]
        .filter(Boolean)
        .join(', ')}
      className={CARD}
    >
      {entries ? (
        <MiniShelf entries={entries} height={SHELF} typicalSeconds={average} />
      ) : (
        <MiniShelfSkeleton
          positions={shelfPositions(series.positions)}
          seconds={average}
          height={SHELF}
        />
      )}
      <View className="gap-0.5">
        {heading ?? (
          <Text
            className="font-display text-[17px] tracking-tight text-foreground"
            numberOfLines={2}
          >
            {series.name}
          </Text>
        )}
        {byline ? (
          <Text variant="muted" numberOfLines={1} style={tabularNums}>
            {byline}
          </Text>
        ) : null}
        <Text variant="caption" style={tabularNums}>
          {summary}
        </Text>
        {where ? (
          <Text variant="caption" numberOfLines={1} className="text-subtle-foreground">
            {where}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A series card while the series list loads. */
export function SeriesCardSkeleton() {
  return (
    <View
      className={CARD}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <MiniShelfSkeleton positions={[1, 2, 3, 4, 5]} height={SHELF} />
      <View className="gap-1.5">
        <Skeleton className="h-4 w-2/3 rounded-sm" />
        <Skeleton className="h-3 w-1/2 rounded-sm" />
      </View>
    </View>
  );
}
