import { Pressable, Text as RNText, View } from 'react-native';

import { Text } from './text';

export type SectionHeaderProps = {
  title: string;
  /** Optional quiet primary text button on the right (e.g. "See all"). */
  action?: { label: string; onPress: () => void };
  className?: string;
};

/**
 * A section heading row: a `heading`-variant title with an optional quiet primary
 * text action on the right. Used to give shelves/lists consistent rhythm.
 */
export function SectionHeader({ title, action, className }: SectionHeaderProps) {
  return (
    <View className={`flex-row items-center justify-between ${className ?? ''}`}>
      <Text variant="heading">{title}</Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          hitSlop={8}
          accessibilityRole="button"
          className="active:opacity-70"
        >
          <RNText className="font-roboto-medium text-sm text-primary">{action.label}</RNText>
        </Pressable>
      ) : null}
    </View>
  );
}
