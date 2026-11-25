import { View } from 'react-native';

import { cn } from '@/lib/utils';
import { useThemeScheme } from '@/theme/use-theme-colors';

/**
 * High contrast only: a 1px `input` outline on a rounded track (its parent, which must
 * be `relative`/clipped and rounded), so the track's full length shows on the page
 * (`input` is 4.5:1 there) while the track itself stays light enough for the brand fill
 * on it to keep 3:1. An overlay, so it changes no size; render it BEFORE the fill, which
 * then covers it: drawn over the fill, its two 1px edges hid half of a 4px bar's fill.
 * Not for a track under about 4px (the edges would be the whole track, and `input`
 * against the brand fill is no 3:1 pair).
 */
export function TrackOutline({ rounded = 'rounded-full' }: { rounded?: string }) {
  const { highContrast } = useThemeScheme();
  if (!highContrast) return null;
  return (
    <View
      testID="track-outline"
      pointerEvents="none"
      className={cn('absolute inset-0 border border-input', rounded)}
    />
  );
}

/**
 * A thin progress bar (STYLEGUIDE section 8): a rounded track (`h-1 bg-track`; size or
 * recolour it with `className`) and the brand fill (recolour it with `fillClassName`: a
 * second bar in a view whose one pink thing is elsewhere) at `fraction` (0..1), never
 * thinner than `minPercent` so a started bar shows. The brand fill is 3:1 on the track;
 * in high contrast the track gets a `TrackOutline` (`outline={false}` for a hairline: the
 * mini player's 2.5px chapter line). Decorative: the text beside it says the figure.
 */
export function ProgressBar({
  fraction,
  minPercent = 0,
  className,
  fillClassName,
  fillTestID,
  outline = true,
}: {
  fraction: number;
  minPercent?: number;
  className?: string;
  fillClassName?: string;
  fillTestID?: string;
  /** False for a track too thin for the high-contrast outline (under about 4px). */
  outline?: boolean;
}) {
  const percent = Math.max(minPercent, Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <View className={cn('h-1 overflow-hidden rounded-full bg-track', className)}>
      {outline ? <TrackOutline /> : null}
      <View
        testID={fillTestID}
        className={cn('h-full rounded-full bg-brand', fillClassName)}
        style={{ width: `${percent}%` }}
      />
    </View>
  );
}
