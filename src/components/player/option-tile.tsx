import { Platform } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { linesFor, useLargeText } from '@/lib/text-scale';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

/**
 * One choice in the speed and sleep sheets' option grids (the prototype's `.opt`): a
 * value over a small caption, ink-filled when it is the current one. A radio (in a
 * `radiogroup` the caller renders), so a screen reader says which is chosen; at least
 * 54 tall, past the 44pt target. Under large text its words wrap instead of ending in
 * "..." and it takes more of its grid's row (`optionTileBasis`).
 */
export function OptionTile({
  title,
  caption,
  selected,
  onPress,
  accessibilityLabel,
  wide,
}: {
  title: string;
  caption?: string;
  selected: boolean;
  onPress: () => void;
  /** Defaults to the title and caption read together. */
  accessibilityLabel?: string;
  /** Takes two tiles' share of the row (the whole row under large text). */
  wide?: boolean;
}) {
  const large = useLargeText();
  const lines = linesFor(1, large);
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
        optionTileBasis(large, wide),
      )}
    >
      <Text
        variant="label"
        className={cn('text-base', selected && 'text-primary-foreground')}
        style={tabularNums}
        numberOfLines={lines}
      >
        {title}
      </Text>
      {caption ? (
        <Text
          variant="caption"
          className={cn(selected && 'text-primary-foreground/80')}
          style={tabularNums}
          numberOfLines={lines}
        >
          {caption}
        </Text>
      ) : null}
    </AnimatedPressable>
  );
}

/** A tile's share of its grid's row: four to a row (`basis-[21%]`), a wide tile two
 * (`wide`); under large text two to a row and a wide tile the whole row. */
function optionTileBasis(large: boolean, wide = false): string {
  if (wide) return large ? 'grow basis-full' : 'grow-[2] basis-[42%]';
  return large ? 'grow basis-[46%]' : 'grow basis-[21%]';
}
