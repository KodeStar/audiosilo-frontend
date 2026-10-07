import { Platform } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

/**
 * One choice in the speed and sleep sheets' option grids (the prototype's `.opt`): a
 * value over a small caption, ink-filled when it is the current one. A radio (in a
 * `radiogroup` the caller renders), so a screen reader says which is chosen; at least
 * 54 tall, past the 44pt target.
 */
export function OptionTile({
  title,
  caption,
  selected,
  onPress,
  accessibilityLabel,
  className,
}: {
  title: string;
  caption?: string;
  selected: boolean;
  onPress: () => void;
  /** Defaults to the title and caption read together. */
  accessibilityLabel?: string;
  className?: string;
}) {
  return (
    <AnimatedPressable
      onPress={onPress}
      role="radio"
      aria-checked={selected}
      accessibilityLabel={accessibilityLabel ?? (caption ? `${title}, ${caption}` : title)}
      className={cn(
        'min-h-[54px] items-center justify-center rounded-xl border px-2 py-2',
        selected ? 'border-primary bg-primary' : 'border-border bg-card active:bg-accent',
        Platform.select({
          web: `cursor-pointer hover:border-border-strong ${FOCUS_RING_OFFSET_CLASS}`,
        }),
        className,
      )}
    >
      <Text
        variant="label"
        className={cn('text-base', selected && 'text-primary-foreground')}
        style={tabularNums}
        numberOfLines={1}
      >
        {title}
      </Text>
      {caption ? (
        <Text
          variant="caption"
          className={cn(selected && 'text-primary-foreground/80')}
          style={tabularNums}
          numberOfLines={1}
        >
          {caption}
        </Text>
      ) : null}
    </AnimatedPressable>
  );
}
