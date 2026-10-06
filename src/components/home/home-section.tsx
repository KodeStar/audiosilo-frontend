import type { ReactNode } from 'react';
import { View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * One Home section: a heading with an optional quiet line beside it and a quiet link
 * to the full list on the right (ink, not pink: the page's pink is the progress), then
 * its body. Phone stacks the link under the heading, as the prototype does.
 */
export function HomeSection({
  title,
  sub,
  action,
  children,
  className,
}: {
  title: string;
  sub?: string;
  action?: { label: string; onPress: () => void };
  children: ReactNode;
  className?: string;
}) {
  const themed = useThemeColors();
  const phone = useLayout() === 'phone';
  const link = action ? (
    <AnimatedPressable
      onPress={action.onPress}
      hitSlop={10}
      accessibilityRole="link"
      accessibilityLabel={action.label}
      className="min-h-[32px] flex-row items-center gap-1 self-start rounded-control"
    >
      <Text variant="label" className="text-muted-foreground">
        {action.label}
      </Text>
      <Icon name="chevron-right" size={13} color={themed.mutedForeground} />
    </AnimatedPressable>
  ) : null;
  return (
    <View className={cn('gap-3.5', className)}>
      <View className={cn(phone ? 'gap-1' : 'flex-row items-baseline justify-between gap-3')}>
        <View className="min-w-0 flex-1 flex-row flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <Text variant="heading" accessibilityRole="header">
            {title}
          </Text>
          {sub ? <Text variant="muted">{sub}</Text> : null}
        </View>
        {link}
      </View>
      {children}
    </View>
  );
}
