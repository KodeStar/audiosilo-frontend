import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { cn } from '@/lib/utils';

import type { ScaleSegment } from './now-card-model';

const TICK_CLASS = {
  past: 'bg-foreground/55',
  current: 'bg-brand',
  ahead: 'bg-muted-foreground/20',
} as const;

/**
 * The Now card's whole-book scale (`bookScale`): a tick per chapter sized by its length,
 * past in ink, the current chapter pink, and a pin above for each bookmark. One image
 * for assistive tech, named by how far through the book the listener is.
 */
export function BookScale({
  segments,
  pins,
  percent,
}: {
  segments: readonly ScaleSegment[];
  /** Bookmarks, 0..1 along the book. */
  pins: readonly number[];
  percent: number;
}) {
  const { t } = useTranslation();
  if (segments.length === 0) return null;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('home.now.scaleLabel', { percent })}
      className="relative h-[30px]"
    >
      {pins.map((at, i) => (
        <View
          key={i}
          pointerEvents="none"
          className="absolute top-0 items-center"
          style={{ left: `${at * 100}%`, width: 8, marginLeft: -4 }}
        >
          <View className="h-2 w-2 rounded-full bg-foreground" />
          <View className="-mt-1 h-2 w-0.5 rounded-sm bg-foreground" />
        </View>
      ))}
      <View className="absolute left-0 right-0 top-[11px] h-3 flex-row gap-[1.5px]">
        {segments.map((s, i) => (
          <View
            key={i}
            className={cn('h-full rounded-[2px]', TICK_CLASS[s.state])}
            style={{ flexGrow: s.weight, flexBasis: 0 }}
          />
        ))}
      </View>
    </View>
  );
}
