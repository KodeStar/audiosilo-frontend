import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { formatTimeOfDay } from '@/lib/format';
import { formatHhMm, parseHhMm } from '@/lib/hhmm';
import { colors } from '@/theme/tokens';

import { Icon } from './icon';
import { Text } from './text';

/** Time-of-day bounds step by half an hour, wrapping around the day. */
export const TIME_STEP_MINUTES = 30;

/**
 * A -/value/+ stepper over a time of day. Unlike the shared `Stepper` it WRAPS
 * (23:30 + 30m = 00:00) rather than clamping, because a nightly window's bounds sit
 * either side of midnight and neither end of the day is a real limit. The value
 * stays canonical "HH:MM"; only the readout is locale-formatted.
 */
export function TimeStepper({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (hhmm: string) => void;
  /** The row's label, used to build the buttons' accessibility labels. */
  label: string;
}) {
  const { t } = useTranslation();
  const minutes = parseHhMm(value) ?? 0;
  const shift = (delta: number) => onChange(formatHhMm(minutes + delta));
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        onPress={() => shift(-TIME_STEP_MINUTES)}
        accessibilityRole="button"
        accessibilityLabel={t('settings.sleep.earlier', { label, minutes: TIME_STEP_MINUTES })}
        className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-860"
      >
        <Icon name="minus" size={14} color={colors.primary} />
      </Pressable>
      <Text variant="subtitle" className="w-24 text-center">
        {formatTimeOfDay(value)}
      </Text>
      <Pressable
        onPress={() => shift(TIME_STEP_MINUTES)}
        accessibilityRole="button"
        accessibilityLabel={t('settings.sleep.later', { label, minutes: TIME_STEP_MINUTES })}
        className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-860"
      >
        <Icon name="plus" size={14} color={colors.primary} />
      </Pressable>
    </View>
  );
}
