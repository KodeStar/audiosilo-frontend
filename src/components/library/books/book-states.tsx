import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/theme/use-theme-colors';

/** A failed load: what went wrong and Retry. Inline (`compact`) when loaded data is
 * still on screen above or below it. */
export function LoadError({
  title,
  hint,
  retryLabel,
  onRetry,
  compact,
}: {
  title: string;
  hint?: string;
  retryLabel: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  const themed = useThemeColors();
  if (!compact) {
    return (
      <EmptyState
        variant="card"
        art={<Icon name="circle-exclamation" size={28} color={themed.destructive} />}
        title={title}
        hint={hint}
        action={{ label: retryLabel, onPress: onRetry }}
      />
    );
  }
  return (
    <View
      role="alert"
      className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2"
    >
      <Icon name="circle-exclamation" size={16} color={themed.destructive} />
      <View className="flex-1">
        <Text variant="label">{title}</Text>
        {hint ? <Text variant="caption">{hint}</Text> : null}
      </View>
      <Button title={retryLabel} variant="outline" size="sm" onPress={onRetry} />
    </View>
  );
}
