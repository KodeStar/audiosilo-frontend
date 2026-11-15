import { View } from 'react-native';

import { cn } from '@/lib/utils';

import { Text } from './text';

/** A keyboard key hint ("⌘K", "esc", "↵"): mono, on a muted keycap. Decorative - the
 * control it sits on carries the accessible name. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <View
      className={cn(
        'min-w-[20px] items-center rounded-md border border-border bg-muted px-[5px]',
        className,
      )}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Text className="font-mono text-[11px] web:text-[0.6875rem] leading-[18px] web:leading-[1.125rem] text-muted-foreground">
        {children}
      </Text>
    </View>
  );
}
