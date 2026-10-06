import { View, type ViewProps } from 'react-native';

import { cn } from '@/lib/utils';

/**
 * A Stacks card (STYLEGUIDE.md section 5): a flat `card` surface with a 1px hairline,
 * radius 16 and 20 padding - chrome never casts a shadow (only covers, spines and
 * floating layers do). react-native-reusables' Card, folded to one View: its
 * header/title/description parts are just `<Text variant="title|muted">` here.
 */
export function Card({ className, ...props }: ViewProps & { className?: string }) {
  return (
    <View className={cn('rounded-card border border-border bg-card p-5', className)} {...props} />
  );
}
