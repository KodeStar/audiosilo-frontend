import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

/** An account page section's heading: the title, one muted line under it, and an
 * optional action on the right (the prototype's `SectionHead`). The action wraps under
 * the title on a narrow column. */
export function AccountSectionHead({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <View className="flex-row flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <View className="min-w-0 shrink gap-0.5">
        <Text variant="heading" accessibilityRole="header">
          {title}
        </Text>
        {sub ? <Text variant="muted">{sub}</Text> : null}
      </View>
      {action}
    </View>
  );
}
