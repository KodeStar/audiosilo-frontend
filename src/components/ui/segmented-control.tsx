import { Pressable, Text as RNText, ScrollView, View } from 'react-native';

export type SegmentedOption<T extends string> = { value: T; label: string };

export type SegmentedControlProps<T extends string> = {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Stretch the segments to fill the row (equal widths) instead of hugging content.
   * `scrollable` wins: inside a horizontal scroller there is no row width to divide,
   * so `grow` is ignored (a `flex-1` pill in a scroller collapses to nothing). */
  grow?: boolean;
  /** Wrap the track in a horizontal scroller, so more options than fit a row stay
   * reachable instead of squashing (the book screen's 7 tabs). `scrollable` wins over
   * `grow`: inside a horizontal scroller there is no row width to divide, so `grow`
   * is ignored. */
  scrollable?: boolean;
  /** Semantics: a plain group of buttons (default), a tab bar - which marks the
   * track as a `tablist` and each pill as a `tab` - or a single choice that switches
   * a view in place, marking the track a `radiogroup` and each pill a `radio` whose
   * `checked` state says which is chosen. Purely an a11y distinction; the visual
   * language is identical on purpose, so they all read as one family. */
  role?: 'button' | 'tab' | 'radio';
  /** The group's accessible name (what is being chosen, e.g. "Reading order"). */
  accessibilityLabel?: string;
  className?: string;
};

/**
 * A pill/segment toggle group: a rounded track with the active option filled in
 * primary (white label) and the rest quiet. Generic over a string union of option
 * values. Screens migrate ad-hoc segment rows onto this; `scrollable` + `role="tab"`
 * is the tab-bar flavour (see `TabBar`).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  grow,
  scrollable,
  role = 'button',
  accessibilityLabel,
  className,
}: SegmentedControlProps<T>) {
  const pills = options.map((opt) => {
    const active = opt.value === value;
    return (
      <Pressable
        key={opt.value}
        onPress={() => onChange(opt.value)}
        accessibilityRole={role}
        accessibilityState={role === 'radio' ? { checked: active } : { selected: active }}
        className={`flex-row items-center justify-center rounded-md px-3 py-1.5 active:opacity-80 ${
          grow && !scrollable ? 'flex-1' : ''
        } ${active ? 'bg-primary' : ''}`}
      >
        <RNText
          className={`font-roboto-medium text-sm ${
            active ? 'text-white' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          {opt.label}
        </RNText>
      </Pressable>
    );
  });

  const track = `rounded-lg bg-gray-100 p-1 dark:bg-gray-840 ${className ?? ''}`;
  const group =
    role === 'tab' ? ('tablist' as const) : role === 'radio' ? ('radiogroup' as const) : undefined;

  if (scrollable) {
    return (
      <View accessibilityRole={group} accessibilityLabel={accessibilityLabel} className={track}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="flex-row gap-1"
        >
          {pills}
        </ScrollView>
      </View>
    );
  }
  return (
    <View
      accessibilityRole={group}
      accessibilityLabel={accessibilityLabel}
      className={`flex-row ${track}`}
    >
      {pills}
    </View>
  );
}
