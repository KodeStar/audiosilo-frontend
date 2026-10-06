import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon, type IconName } from './icon';
import { Text } from './text';

/**
 * A Stacks filter chip (STYLEGUIDE section 8, "Chip"): 32 tall, a pill with a strong
 * hairline on `card`, an optional leading glyph and count (subtle tabular figures); on,
 * it fills with ink (`primary`). It toggles a filter, so it is a checkbox to assistive
 * tech (checked = on). The slop makes the touch target 44.
 */
export function FilterChip({
  label,
  selected,
  onPress,
  count,
  icon,
  accessibilityLabel,
  className,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  count?: number;
  icon?: IconName;
  /** Defaults to the label plus the count. */
  accessibilityLabel?: string;
  className?: string;
}) {
  const themed = useThemeColors();
  return (
    <Pressable
      role="checkbox"
      aria-checked={selected}
      accessibilityState={{ checked: selected }}
      accessibilityLabel={
        accessibilityLabel ?? (count === undefined ? label : `${label}, ${count}`)
      }
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      className={cn(
        'h-8 shrink-0 flex-row items-center gap-1.5 rounded-full border px-3',
        selected
          ? 'border-primary bg-primary'
          : 'border-border-strong bg-card active:bg-accent hover:bg-accent',
        Platform.select({
          web: 'cursor-pointer select-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        }),
        className,
      )}
    >
      {icon ? (
        <Icon
          name={icon}
          size={14}
          color={selected ? themed.primaryForeground : themed.foreground}
        />
      ) : null}
      <Text
        className={cn(
          'font-sans-semibold text-[13px]',
          selected ? 'text-primary-foreground' : 'text-foreground',
        )}
        numberOfLines={1}
      >
        {label}
      </Text>
      {count === undefined ? null : (
        <Text
          className={cn(
            'font-sans text-[11.5px] opacity-60',
            selected ? 'text-primary-foreground' : 'text-foreground',
          )}
          style={tabularNums}
        >
          {formatCount(count)}
        </Text>
      )}
    </Pressable>
  );
}

/** A thin divider between groups of chips in a `ChipRow`. */
export function ChipSeparator() {
  return <View className="h-5 w-px shrink-0 bg-border" />;
}

/**
 * A horizontally scrolling row of filter chips (with `ChipSeparator`s between groups),
 * bleeding past the page padding (`gutter`) so chips scroll to the window edge.
 */
export function ChipRow({
  children,
  accessibilityLabel,
  gutter = 0,
  className,
}: {
  children: ReactNode;
  /** What the chips filter ("Filters"). */
  accessibilityLabel: string;
  gutter?: number;
  className?: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      role="group"
      accessibilityLabel={accessibilityLabel}
      style={gutter ? { marginHorizontal: -gutter } : undefined}
      className={cn('grow-0', className)}
      contentContainerClassName="flex-row items-center gap-2 py-1.5"
      contentContainerStyle={gutter ? { paddingHorizontal: gutter } : undefined}
    >
      {children}
    </ScrollView>
  );
}
