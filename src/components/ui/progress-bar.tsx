import { View } from 'react-native';

import { cn } from '@/lib/utils';

/**
 * A thin progress bar (STYLEGUIDE section 8): a rounded track (`h-1 bg-muted`; size or
 * recolour it with `className`) and the brand fill at `fraction` (0..1), never thinner
 * than `minPercent` so a started bar shows. Decorative: the text beside it says the
 * figure.
 */
export function ProgressBar({
  fraction,
  minPercent = 0,
  className,
  fillTestID,
}: {
  fraction: number;
  minPercent?: number;
  className?: string;
  fillTestID?: string;
}) {
  const percent = Math.max(minPercent, Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <View className={cn('h-1 overflow-hidden rounded-full bg-muted', className)}>
      <View
        testID={fillTestID}
        className="h-full rounded-full bg-brand"
        style={{ width: `${percent}%` }}
      />
    </View>
  );
}
