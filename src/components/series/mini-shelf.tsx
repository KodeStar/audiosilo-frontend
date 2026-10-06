import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Ledge } from '@/components/library/shelf-row';
import { Skeleton } from '@/components/ui/skeleton';

import type { SeriesEntry } from './series-model';
import { Spine } from './spine';
import { hashString, spineDims } from './spine-fit';

/** The full-size spine height the mini shelves scale down from. */
const FULL = 200;

/**
 * A short shelf of a series' spines (the Library's series cards, the author page):
 * the listener's own spines in series order with dashed ghosts for the gaps, standing on
 * a plank against a bookend. Decorative: the card around it carries the name and the
 * action, so it is hidden from assistive tech.
 */
export function MiniShelf({
  entries,
  height = 120,
  typicalSeconds,
}: {
  entries: readonly SeriesEntry[];
  /** The tallest spine's height; everything scales from it. */
  height?: number;
  /** The width stand-in for ghosts (the series' typical length). */
  typicalSeconds?: number;
}) {
  const { t } = useTranslation();
  const scale = height / FULL;
  return (
    <ShelfFrame height={height}>
      {entries.map((e) => {
        const title = e.title ?? t('covers.bookNumber', { position: e.position });
        const { width, height: h } = spineDims(e.seconds ?? typicalSeconds, title, scale);
        return (
          <Spine
            key={e.key}
            title={title}
            position={e.position}
            width={width}
            height={h}
            scale={scale}
            variant={e.kind === 'owned' ? 'book' : e.kind}
            coverColor={e.coverColor}
            finished={e.finished}
          />
        );
      })}
    </ShelfFrame>
  );
}

/** The loading state of a `MiniShelf`: spine-shaped placeholders for the positions the
 * series is known to hold, at the sizes the spines will have (no shift when they land). */
export function MiniShelfSkeleton({
  positions,
  seconds,
  height = 120,
}: {
  positions: readonly number[];
  /** The series' average book length. */
  seconds?: number;
  height?: number;
}) {
  const scale = height / FULL;
  return (
    <ShelfFrame height={height}>
      {positions.map((p, i) => {
        const { width, height: h } = spineDims(seconds, String(hashString(`${p}:${i}`)), scale);
        return (
          <View key={i} style={{ width, height: h }}>
            <Skeleton className="h-full w-full rounded-sm" />
          </View>
        );
      })}
    </ShelfFrame>
  );
}

function ShelfFrame({ height, children }: { height: number; children: React.ReactNode }) {
  // Room above the tallest spine, then the plank's 8 and its shadow below.
  const room = Math.round(height * 1.12);
  return (
    <View
      style={{ height: room + 20 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Ledge top={room} />
      <View style={{ height: room, gap: 3 }} className="flex-row items-end overflow-hidden px-1.5">
        {children}
        <View className="flex-1" />
        <View
          className="mr-1 rounded-t border-r-2 border-foreground/5 bg-shelf-edge"
          style={{ width: 22, height: Math.round(height * 0.46) }}
        />
      </View>
    </View>
  );
}
