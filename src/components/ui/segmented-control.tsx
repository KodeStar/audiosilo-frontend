import { Pressable, Text as RNText, View } from 'react-native';

export type SegmentedOption<T extends string> = { value: T; label: string };

export type SegmentedControlProps<T extends string> = {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Stretch the segments to fill the row (equal widths) instead of hugging content. */
  grow?: boolean;
  className?: string;
};

/**
 * A pill/segment toggle group: a rounded track with the active option filled in
 * primary (white label) and the rest quiet. Generic over a string union of option
 * values. Screens migrate ad-hoc segment rows onto this.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  grow,
  className,
}: SegmentedControlProps<T>) {
  return (
    <View className={`flex-row rounded-lg bg-gray-100 p-1 dark:bg-gray-840 ${className ?? ''}`}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            className={`flex-row items-center justify-center rounded-md px-3 py-1.5 active:opacity-80 ${
              grow ? 'flex-1' : ''
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
      })}
    </View>
  );
}
