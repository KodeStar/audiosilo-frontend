import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';

import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { usePlayer } from '@/playback/store';

const fmt = (v: number) => `${Number(v.toFixed(2))}×`;

/** Tappable speed readout that opens a stepper (0.1× increments). */
export function SpeedButton() {
  const [open, setOpen] = useState(false);
  const rate = usePlayer((s) => s.rate);
  const setRate = usePlayer((s) => s.setRate);

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
            onPress={() => {}}
          >
            <Text variant="title">Playback speed</Text>
            <View className="items-center py-2">
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
