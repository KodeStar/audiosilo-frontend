import { View } from 'react-native';

import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

import { AnimatedPressable } from './animated-pressable';
import { Icon } from './icon';
import { Sheet } from './sheet';
import { Text } from './text';

export type SelectOption<T extends string> = { value: T; label: string };

/**
 * A one-line "pick a value" row for a settings card: the label on the left, the
 * current value plus a chevron on the right. It only reports the tap - the caller
 * owns the open state and renders the matching `SelectSheet`.
 *
 * The row and the sheet are deliberately SEPARATE components: a `Sheet` renders in
 * place (see `sheet.tsx`), so it must be mounted at screen level and would be
 * clipped if this row rendered it from inside a card or a ScrollView.
 *
 * Use it where a `SegmentedControl` has too many options to stay readable on a
 * phone (roughly four or more). It always draws its hairline separator, so it
 * belongs below other rows in a card rather than at the top of one.
 */
export function SelectRow({
  label,
  value,
  onPress,
}: {
  label: string;
  /** The selected option's label, shown on the right. */
  value: string;
  onPress: () => void;
}) {
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textMuted : colors.light.textMuted;
  return (
    <AnimatedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      className="flex-row items-center justify-between border-t border-black/5 px-4 py-3.5 dark:border-white/5"
    >
      <Text numberOfLines={1} className="pr-3">
        {label}
      </Text>
      <View className="flex-row items-center gap-2">
        <Text variant="subtitle" numberOfLines={1}>
          {value}
        </Text>
        <Icon name="chevron-right" size={14} color={neutral} />
      </View>
    </AnimatedPressable>
  );
}

/**
 * The bottom sheet a `SelectRow` opens: one tappable row per option, with the
 * selected one marked (a check plus `accessibilityState.selected`). Picking an
 * option reports it and leaves closing to the caller's `onClose`.
 *
 * Mount this at screen level (never inside a card or ScrollView) - see `Sheet`.
 */
export function SelectSheet<T extends string>({
  visible,
  title,
  options,
  value,
  onChange,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View className="gap-2 px-4 pb-4 pt-1">
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <AnimatedPressable
              key={opt.value}
              onPress={() => {
                onChange(opt.value);
                onClose();
              }}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={opt.label}
              className={`flex-row items-center justify-between rounded-lg px-4 py-3 ${
                selected ? 'bg-primary/10' : 'bg-gray-100 dark:bg-gray-860'
              }`}
            >
              <Text variant="title">{opt.label}</Text>
              {selected ? <Icon name="check" size={16} color={colors.primary} /> : null}
            </AnimatedPressable>
          );
        })}
      </View>
    </Sheet>
  );
}
