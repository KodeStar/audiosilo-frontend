import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Chapter } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatClock, formatCountdown } from '@/lib/format';
import { chapterCountdowns } from '@/playback/book-queue';
import { wallClockSeconds } from '@/playback/rate';
import { useSleepTimer } from '@/playback/sleep-timer';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const PRESETS = [5, 10, 15, 20, 30, 45, 60];

export function SleepTimerButton() {
  const { t } = useTranslation();
  const chapterLabel = (ch: Chapter) =>
    ch.title || t('player.chapters.chapterNumber', { number: ch.index + 1 });
  const [open, setOpen] = useState(false);
  const active = useSleepTimer((s) => s.active);
  const label = useSleepTimer((s) => s.label);
  const remaining = useSleepTimer((s) => s.remaining);
  const startDuration = useSleepTimer((s) => s.startDuration);
  const startUntilPosition = useSleepTimer((s) => s.startUntilPosition);
  const cancel = useSleepTimer((s) => s.cancel);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const bookPosition = usePlayer(selectBookPosition);
  const rate = usePlayer((s) => s.rate);
  const { scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;

  const pick = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  // Show at least 5 chapters, extending until one passes the 2-hour mark (an hour
  // ran short on both listening time and chapter count). Wall-clock, so the window
  // shrinks with speed - at 2x it spans ~2h of real time, ~4h of content.
  const countdowns = nowPlaying
    ? chapterCountdowns(
        nowPlaying.queue.chapters,
        bookPosition,
        { minCount: 5, maxSeconds: 7200 },
        rate,
      )
    : [];
  const total = nowPlaying?.queue.total ?? 0;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        className="flex-row items-center gap-1.5"
        hitSlop={8}
      >
        <Icon name="sleep" size={20} color={active ? colors.primary : neutral} />
        {active && remaining !== null && (
          <Text className="text-sm text-primary">{formatClock(remaining)}</Text>
        )}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 justify-end bg-black/40" onPress={() => setOpen(false)}>
          <Pressable
            className="gap-3 rounded-t-2xl bg-gray-100 p-4 dark:bg-gray-840"
            style={{ paddingBottom: insets.bottom + 24 }}
            onPress={() => {}}
          >
            <View className="flex-row items-center justify-between">
              <Text variant="title">{t('player.sleepTimer.title')}</Text>
              <Pressable
                onPress={() => setOpen(false)}
                hitSlop={12}
                className="h-8 w-8 items-center justify-center"
              >
                <Icon name="close" size={22} color={neutral} />
              </Pressable>
            </View>

            {active ? (
              <View className="flex-row items-center justify-between rounded-lg bg-primary/10 px-3 py-2">
                <Text className="text-primary">{label || t('player.sleepTimer.running')}</Text>
                {remaining !== null ? (
                  <Text className="font-roboto-semibold text-primary">
                    {formatClock(remaining)}
                  </Text>
                ) : null}
              </View>
            ) : null}

            <Text variant="caption" className="uppercase tracking-wide">
              {t('player.sleepTimer.timeSection')}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {PRESETS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => pick(() => startDuration(m))}
                  className="rounded-full bg-white px-4 py-2 dark:bg-gray-860"
                >
                  <Text>{t('player.sleepTimer.minutes', { count: m })}</Text>
                </Pressable>
              ))}
            </View>

            <Text variant="caption" className="uppercase tracking-wide">
              {t('player.sleepTimer.endOfChapterSection')}
            </Text>
            {countdowns.length > 0 ? (
              // Cap height on the wrapper View (not the ScrollView itself) so the
              // list scrolls instead of pushing the sheet off-screen - the same
              // pattern the player's history/notes sheet uses.
              <View className="max-h-72">
                <ScrollView contentContainerClassName="gap-2" keyboardShouldPersistTaps="handled">
                  {countdowns.map((c, i) => (
                    <Pressable
                      key={c.chapter.index}
                      onPress={() =>
                        pick(() =>
                          startUntilPosition(
                            c.endPosition,
                            t('player.sleepTimer.endOf', { chapter: chapterLabel(c.chapter) }),
                          ),
                        )
                      }
                      className="flex-row items-center justify-between rounded-lg bg-white px-4 py-3 dark:bg-gray-860"
                    >
                      <Text numberOfLines={1} className="flex-1 pr-3">
                        {chapterLabel(c.chapter)}
                        {i === 0 ? t('player.sleepTimer.current') : ''}
                      </Text>
                      <Text variant="caption">{formatCountdown(c.untilEnd)}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : nowPlaying ? (
              <Pressable
                onPress={() =>
                  pick(() => startUntilPosition(total, t('player.sleepTimer.endOfBook')))
                }
                className="flex-row items-center justify-between rounded-lg bg-white px-4 py-3 dark:bg-gray-860"
              >
                <Text>{t('player.sleepTimer.endOfBook')}</Text>
                <Text variant="caption">
                  {formatCountdown(wallClockSeconds(total - bookPosition, rate))}
                </Text>
              </Pressable>
            ) : (
              <Text variant="caption">{t('player.sleepTimer.noChapters')}</Text>
            )}

            {active ? (
              <Pressable
                onPress={() => pick(cancel)}
                className="mt-1 items-center rounded-lg bg-primary px-4 py-3 active:opacity-80"
              >
                <Text className="font-roboto-semibold text-white dark:text-white">
                  {t('player.sleepTimer.cancel')}
                </Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
