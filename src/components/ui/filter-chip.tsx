import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { HORIZONTAL_SCROLLER } from './horizontal-scroller';
import { Icon, type IconName } from './icon';
import { FOCUS_RING_OFFSET_CLASS, Text } from './text';

/**
 * The Stacks 32px pill (STYLEGUIDE section 8, "Chip"): a strong hairline on `card`,
 * `accent` under a press or hover, filled with ink (`primary`) when `selected`. A
 * `FilterChip`'s box, and the pills that act or link rather than toggle (a book's genres
 * and tags, a recent search); the caller adds the width rule (`shrink-0` in a scrolling
 * row, `max-w-full` where they wrap) and its own slop (`hitSlop` 6 above and below makes
 * the touch target 44).
 */
export function chipClass(selected = false): string {
  return cn(
    'h-8 flex-row items-center gap-1.5 rounded-full border px-3',
    selected
      ? 'border-primary bg-primary'
      : 'border-border-strong bg-card active:bg-accent hover:bg-accent',
    Platform.select({
      web: `cursor-pointer select-none transition-colors ${FOCUS_RING_OFFSET_CLASS}`,
    }),
  );
}

/**
 * A Stacks filter chip (STYLEGUIDE section 8, "Chip"): 32 tall, a pill with a strong
 * hairline on `card`, an optional leading glyph and count (subtle tabular figures); on,
 * it fills with ink (`primary`). It toggles a filter, so it is a checkbox to assistive
 * tech (checked = on). A `picker` chip opens a choice instead (a genre or tag filter): a
 * button with a trailing chevron, selected while its filter is on. The slop makes the
 * touch target 44.
 */
export function FilterChip({
  label,
  selected,
  onPress,
  count,
  icon,
  picker = false,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  count?: number;
  icon?: IconName;
  picker?: boolean;
  /** What a screen reader says instead of the label (the count still follows). */
  accessibilityLabel?: string;
}) {
  const themed = useThemeColors();
  const spoken = accessibilityLabel ?? label;
  const fg = selected ? themed.primaryForeground : themed.foreground;
  return (
    <Pressable
      role={picker ? 'button' : 'checkbox'}
      aria-checked={picker ? undefined : selected}
      accessibilityState={picker ? { selected } : { checked: selected }}
      accessibilityLabel={count === undefined ? spoken : `${spoken}, ${count}`}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      className={cn(chipClass(selected), 'shrink-0')}
    >
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
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
      {picker ? <Icon name="chevron-down" size={12} color={fg} /> : null}
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
}: {
  children: ReactNode;
  /** What the chips filter ("Filters"). */
  accessibilityLabel: string;
  gutter?: number;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      role="group"
      accessibilityLabel={accessibilityLabel}
      testID="chip-row"
      style={[HORIZONTAL_SCROLLER, gutter ? { marginHorizontal: -gutter } : undefined]}
      contentContainerClassName="flex-row items-center gap-2 py-1.5"
      contentContainerStyle={gutter ? { paddingHorizontal: gutter } : undefined}
    >
      {children}
    </ScrollView>
  );
}
