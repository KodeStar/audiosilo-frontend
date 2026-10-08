import type { ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { Text } from './text';

/**
 * A page section's or a card's heading: the title (a header for assistive tech), one
 * muted line under it, and an optional control on the right that wraps under the title on
 * a narrow column (Your listening's cards, the Account page's sections). `small` is a
 * card's smaller head. (A shelf's heading with a "See all" link is `SectionHeader`.)
 */
export function SectionTitle({
  title,
  sub,
  small = false,
  action,
  className,
}: {
  title: string;
  sub?: ReactNode;
  small?: boolean;
  action?: ReactNode;
  /** The row's classes when there is an action (its alignment, its gaps). */
  className?: string;
}) {
  const heading = (
    <View className="min-w-0 shrink gap-0.5">
      <Text variant={small ? 'title' : 'heading'} accessibilityRole="header">
        {title}
      </Text>
      {sub ? (
        <Text variant={small ? 'caption' : 'muted'} style={tabularNums}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
  if (!action) return heading;
  return (
    <View className={cn('flex-row flex-wrap items-end justify-between gap-x-4 gap-y-2', className)}>
      {heading}
      {action}
    </View>
  );
}
