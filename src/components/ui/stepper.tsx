import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon } from './icon';
import { Text } from './text';
import { touchTarget } from './touch-target';

/** The drawn step button's size in rem (`h-9 w-9`). */
const STEP_REM = 2.25;

/**
 * One − or + button of a stepper: a 36 px circle with a 44 pt target (`touchTarget`: a real
 * frame on iOS and Android, a slop on the web), named for a screen reader. The glyph is
 * ink, like the other secondary controls (one pink thing per view: a Settings pane has a
 * stepper on every row); disabled, the whole button fades.
 */
export function StepButton({
  icon,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  icon: 'minus' | 'plus';
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const themed = useThemeColors();
  const { frameClass, hitSlop } = touchTarget(STEP_REM, STEP_REM);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      className={cn('items-center justify-center', frameClass)}
    >
      <View
        className={cn(
          'h-9 w-9 items-center justify-center rounded-full bg-muted',
          disabled && 'opacity-40',
        )}
      >
        <Icon name={icon} size={14} color={themed.foreground} />
      </View>
    </Pressable>
  );
}

/** A −/value/+ stepper. Used for skip seconds and playback speed. `label` names the
 * setting, so a screen reader hears "Skip back, less" and the value. */
export function Stepper({
  value,
  onChange,
  step,
  min,
  max,
  format,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  step: number;
  min: number;
  max: number;
  format: (v: number) => string;
  label: string;
}) {
  const { t } = useTranslation();
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v * 100) / 100)));
  return (
    <View className="flex-row items-center gap-3">
      <StepButton
        icon="minus"
        onPress={() => set(value - step)}
        disabled={value <= min}
        accessibilityLabel={t('settings.stepper.less', { label })}
      />
      <Text variant="label" className="w-16 text-center" accessibilityLiveRegion="polite">
        {format(value)}
      </Text>
      <StepButton
        icon="plus"
        onPress={() => set(value + step)}
        disabled={value >= max}
        accessibilityLabel={t('settings.stepper.more', { label })}
      />
    </View>
  );
}
