import type { ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';

import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { Portrait } from './portrait';

/**
 * A person as a pill (an author or narrator page's "Read by", Search's people): their
 * portrait, the name (or `label`, a highlighted one) and an optional `caption` (their
 * role), opening their page.
 */
export function PersonChip({
  name,
  kind,
  onPress,
  label,
  caption,
  accessibilityLabel,
  accessibilityRole = 'link',
}: {
  name: string;
  kind: 'author' | 'narrator';
  onPress: () => void;
  label?: ReactNode;
  caption?: string;
  accessibilityLabel?: string;
  accessibilityRole?: 'link' | 'button';
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? name}
      className={cn(
        'h-11 max-w-full flex-row items-center gap-2 rounded-full border border-border-strong bg-card pl-[5px] pr-3.5 active:bg-accent',
        Platform.select({
          web: `cursor-pointer transition-colors hover:bg-accent ${FOCUS_RING_OFFSET_CLASS}`,
        }),
      )}
    >
      <Portrait name={name} kind={kind} size={34} />
      <View className="shrink">
        {label ?? (
          <Text variant="label" numberOfLines={1}>
            {name}
          </Text>
        )}
      </View>
      {caption ? (
        <Text variant="caption" numberOfLines={1}>
          {caption}
        </Text>
      ) : null}
    </Pressable>
  );
}
