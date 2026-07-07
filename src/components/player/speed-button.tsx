import { useTranslation } from 'react-i18next';
import { Text as RNText, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Sheet } from '@/components/ui/sheet';
import { Stepper } from '@/components/ui/stepper';
import { usePlayer } from '@/playback/store';

const fmt = (v: number) => `${Number(v.toFixed(2))}×`;

/**
 * Speed readout button. The sheet is mounted separately (`SpeedSheet`) at the
 * player's root so the shared bottom `Sheet` presents correctly - a Sheet nested
 * here in the footer would be clipped to the footer's bounds.
 */
export function SpeedButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const rate = usePlayer((s) => s.rate);

  return (
    <AnimatedPressable
      onPress={onPress}
      hitSlop={8}
      className="rounded-full px-2 py-1"
      accessibilityRole="button"
      accessibilityLabel={t('player.speed.title')}
    >
      {/* Raw RN Text + explicit classes: the themed <Text> variant injects its own
          text color, which NativeWind won't reliably override with an appended one. */}
      <RNText className="font-roboto-medium text-base text-gray-700 dark:text-gray-200">
        {fmt(rate)}
      </RNText>
    </AnimatedPressable>
  );
}

/** The playback-speed stepper sheet, controlled by the player. */
export function SpeedSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const rate = usePlayer((s) => s.rate);
  const setRate = usePlayer((s) => s.setRate);

  return (
    <Sheet inline visible={visible} onClose={onClose} title={t('player.speed.title')}>
      <View className="items-center px-4 pb-8 pt-2">
        <Stepper
          value={rate}
          onChange={(v) => void setRate(v)}
          step={0.05}
          min={0.5}
          max={2}
          format={fmt}
        />
      </View>
    </Sheet>
  );
}
