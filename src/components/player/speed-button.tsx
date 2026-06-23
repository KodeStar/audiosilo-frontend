import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const fmt = (v: number) => `${Number(v.toFixed(2))}×`;

/** Tappable speed readout that opens a stepper (0.1× increments). */
export function SpeedButton() {
  const [open, setOpen] = useState(false);
  const rate = usePlayer((s) => s.rate);
  const setRate = usePlayer((s) => s.setRate);
  const { scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={8}
        className="rounded-full px-2 py-1 active:opacity-70"
      >
        <Text className="font-roboto-medium text-base text-gray-700 dark:text-gray-200">
          {fmt(rate)}
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 justify-end bg-black/40" onPress={() => setOpen(false)}>
          <Pressable
            className="gap-4 rounded-t-2xl bg-gray-100 p-4 dark:bg-gray-840"
            // Extra bottom room so the stepper sits well clear of the home
            // indicator / Siri bar (a Modal ignores the screen's safe-area inset).
            style={{ paddingBottom: insets.bottom + 40 }}
            onPress={() => {}}
          >
            <View className="flex-row items-center justify-between">
              <Text variant="title">Playback speed</Text>
              <Pressable
                onPress={() => setOpen(false)}
                hitSlop={12}
                className="h-8 w-8 items-center justify-center"
              >
                <Icon name="close" size={22} color={neutral} />
              </Pressable>
            </View>
            <View className="items-center pt-2 pb-4">
              <Stepper
                value={rate}
                onChange={(v) => void setRate(v)}
                step={0.05}
                min={0.5}
                max={2}
                format={fmt}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
