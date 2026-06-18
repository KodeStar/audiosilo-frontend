import { Pressable, View } from 'react-native';

import { colors } from '@/theme/tokens';

import { Icon } from './icon';
import { Text } from './text';

/** A −/value/+ stepper. Used for skip seconds and playback speed. */
export function Stepper({
  value,
  onChange,
  step,
  min,
  max,
  format,
}: {
  value: number;
  onChange: (v: number) => void;
  step: number;
  min: number;
  max: number;
  format: (v: number) => string;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v * 100) / 100)));
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        onPress={() => set(value - step)}
        disabled={value <= min}
        className={`h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-860 ${value <= min ? 'opacity-40' : ''}`}
      >
        <Icon name="minus" size={14} color={colors.primary} />
      </Pressable>
      <Text variant="subtitle" className="w-16 text-center">
        {format(value)}
      </Text>
      <Pressable
        onPress={() => set(value + step)}
        disabled={value >= max}
        className={`h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-860 ${value >= max ? 'opacity-40' : ''}`}
      >
        <Icon name="plus" size={14} color={colors.primary} />
      </Pressable>
    </View>
  );
}
