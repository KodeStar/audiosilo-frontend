import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Four dashed ghost spines leaning on each other: an empty shelf (decorative). */
export function GhostSpines() {
  return (
    <View
      className="h-[130px] flex-row items-end"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          style={{
            height: 90 + i * 12,
            width: 26 + i * 3,
            transform: i === 3 ? [{ rotate: '12deg' }, { translateX: 8 }] : undefined,
          }}
          className="mr-0.5 rounded-t-[4px] border-[1.5px] border-dashed border-subtle-foreground bg-muted"
        />
      ))}
    </View>
  );
}

/** Three dashed ghost covers fanned out: nothing here (decorative). */
export function GhostCovers() {
  return (
    <View
      className="h-[72px] flex-row items-center"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {[-1, 0, 1].map((i) => (
        <View
          key={i}
          style={{ transform: [{ rotate: `${i * 8}deg` }], marginLeft: i === -1 ? 0 : -12 }}
          className="h-[54px] w-[54px] rounded-[5px] border-[1.5px] border-dashed border-subtle-foreground bg-muted"
        />
      ))}
    </View>
  );
}

/**
 * A list's empty or error state (STYLEGUIDE section 8: one picture, one headline, one
 * sentence, one action) on a quiet card.
 */
export function StateNotice({
  art,
  title,
  hint,
  action,
  className,
}: {
  art?: ReactNode;
  title: string;
  hint?: string;
  action?: { label: string; onPress: () => void };
  className?: string;
}) {
  return (
    <View
      className={cn(
        'items-center gap-3 rounded-2xl border border-border bg-card px-6 py-10',
        className,
      )}
    >
      {art}
      <Text variant="heading" className="text-center">
        {title}
      </Text>
      {hint ? (
        <Text variant="muted" className="max-w-[440px] text-center">
          {hint}
        </Text>
      ) : null}
      {action ? (
        <Button title={action.label} variant="outline" size="sm" onPress={action.onPress} />
      ) : null}
    </View>
  );
}

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
      <StateNotice
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
