import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { useSleepTimer } from '@/playback/sleep-timer';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const PRESETS = [5, 10, 15, 20, 30, 45, 60];

export function SleepTimerButton() {
  const [open, setOpen] = useState(false);
  const active = useSleepTimer((s) => s.active);
  const remaining = useSleepTimer((s) => s.remaining);
  const startDuration = useSleepTimer((s) => s.startDuration);
  const startEndOfChapter = useSleepTimer((s) => s.startEndOfChapter);
  const cancel = useSleepTimer((s) => s.cancel);
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;

  const pick = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  return (
    <>
      <Pressable onPress={() => setOpen(true)} className="flex-row items-center gap-1.5" hitSlop={8}>
        <Icon name="sleep" size={20} color={active ? colors.primary : neutral} />
        {active && remaining !== null ? (
          <Text className="text-sm text-primary">{formatClock(remaining)}</Text>
        ) : (
          <Text variant="caption">Sleep</Text>
        )}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 justify-end bg-black/40" onPress={() => setOpen(false)}>
          <Pressable className="gap-3 rounded-t-2xl bg-gray-100 p-4 dark:bg-gray-840" onPress={() => {}}>
            <Text variant="title">Sleep timer</Text>
            <View className="flex-row flex-wrap gap-2">
              {PRESETS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => pick(() => startDuration(m))}
                  className="rounded-full bg-white px-4 py-2 dark:bg-gray-860"
                >
                  <Text>{m} min</Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => pick(startEndOfChapter)}
                className="rounded-full bg-white px-4 py-2 dark:bg-gray-860"
              >
                <Text>End of chapter</Text>
              </Pressable>
            </View>
            {active ? (
              <Pressable
                onPress={() => pick(cancel)}
                className="mt-1 items-center rounded-lg bg-primary px-4 py-3 active:opacity-80"
              >
                <Text className="font-roboto-semibold text-white dark:text-white">Cancel timer</Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
