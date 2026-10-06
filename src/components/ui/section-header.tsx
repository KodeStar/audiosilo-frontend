import { Pressable, Text as RNText, View } from 'react-native';

import { cn } from '@/lib/utils';

import { Text } from './text';

export type SectionHeaderProps = {
  title: string;
  /** Optional quiet brand-ink text button on the right (e.g. "See all"). */
  action?: { label: string; onPress: () => void };
  className?: string;
};

/**
 * A section heading row: a `heading`-variant title with an optional quiet brand-ink
 * text action on the right. Used to give shelves/lists consistent rhythm.
 */
export function SectionHeader({ title, action, className }: SectionHeaderProps) {
  return (
    <View className={cn('flex-row items-center justify-between', className)}>
      <Text variant="heading">{title}</Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          hitSlop={8}
          accessibilityRole="button"
          className="active:opacity-70"
        >
          <RNText className="font-sans-medium text-sm text-brand-ink">{action.label}</RNText>
        </Pressable>
      ) : null}
    </View>
  );
}
