import { useTranslation } from 'react-i18next';
import { ScrollView, Text as RNText, View } from 'react-native';

import type { Chapter } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { formatClock, formatCountdown } from '@/lib/format';
import { chapterCountdowns } from '@/playback/book-queue';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { wallClockSeconds } from '@/playback/rate';
import { useSleepTimer } from '@/playback/sleep-timer';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { colors } from '@/theme/tokens';

const PRESETS = [5, 10, 15, 20, 30, 45, 60];
const TABULAR = { fontVariant: ['tabular-nums' as const] };

/**
 * Sleep-timer trigger. Shows the current remaining time when active. The sheet
 * itself (`SleepSheet`) is mounted at the player root so the shared bottom `Sheet`
 * presents correctly.
 */
export function SleepTimerButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const active = useSleepTimer((s) => s.active);
  const remaining = useSleepTimer((s) => s.remaining);

  return (
    <AnimatedPressable
      onPress={onPress}
      className="flex-row items-center gap-1.5"
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('player.sleepTimer.title')}
    >
      <Icon name="sleep" size={20} color={active ? colors.primary : colors.dark.text} />
      {active && remaining !== null ? (
        <RNText className="font-sans text-sm text-primary" style={TABULAR}>
          {formatClock(remaining)}
        </RNText>
      ) : null}
    </AnimatedPressable>
  );
}

/** The sleep-timer presets / end-of-chapter sheet, controlled by the player. */
export function SleepSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const chapterLabel = (ch: Chapter) =>
    prettifyChapterTitle(ch.title || t('player.chapters.chapterNumber', { number: ch.index + 1 }));
  const active = useSleepTimer((s) => s.active);
  const label = useSleepTimer((s) => s.label);
  const remaining = useSleepTimer((s) => s.remaining);
  const startDuration = useSleepTimer((s) => s.startDuration);
  const startUntilPosition = useSleepTimer((s) => s.startUntilPosition);
  const cancel = useSleepTimer((s) => s.cancel);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const bookPosition = usePlayer(selectBookPosition);
  const rate = usePlayer((s) => s.rate);

  const pick = (fn: () => void) => {
    fn();
    onClose();
  };

  // Show at least 5 chapters, extending until one passes the 2-hour mark. Wall-clock,
  // so the window shrinks with speed - at 2x it spans ~2h of real time, ~4h content.
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
    <Sheet inline visible={visible} onClose={onClose} title={t('player.sleepTimer.title')}>
      <View className="gap-3 px-4 pb-4">
        {active ? (
          <View className="flex-row items-center justify-between rounded-lg bg-primary/10 px-3 py-2">
            <RNText className="font-sans text-base text-primary">
              {label || t('player.sleepTimer.running')}
            </RNText>
            {remaining !== null ? (
              <RNText className="font-roboto-semibold text-base text-primary" style={TABULAR}>
                {formatClock(remaining)}
              </RNText>
            ) : null}
          </View>
        ) : null}

        <Text variant="label">{t('player.sleepTimer.timeSection')}</Text>
        <View className="flex-row flex-wrap gap-2">
          {PRESETS.map((m) => (
            <AnimatedPressable
              key={m}
              onPress={() => pick(() => startDuration(m))}
              className="rounded-full bg-gray-100 px-4 py-2 dark:bg-gray-860"
              accessibilityRole="button"
            >
              <Text style={TABULAR}>{t('player.sleepTimer.minutes', { count: m })}</Text>
            </AnimatedPressable>
          ))}
        </View>

        <Text variant="label">{t('player.sleepTimer.endOfChapterSection')}</Text>
        {countdowns.length > 0 ? (
          // Cap on the wrapper View (not the ScrollView) so the list scrolls
          // instead of pushing the sheet off-screen.
          <View className="max-h-72">
            <ScrollView contentContainerClassName="gap-2" keyboardShouldPersistTaps="handled">
              {countdowns.map((c, i) => (
                <AnimatedPressable
                  key={c.chapter.index}
                  onPress={() =>
                    pick(() =>
                      startUntilPosition(
                        c.endPosition,
                        t('player.sleepTimer.endOf', { chapter: chapterLabel(c.chapter) }),
                      ),
                    )
                  }
                  className="flex-row items-center justify-between rounded-lg bg-gray-100 px-4 py-3 dark:bg-gray-860"
                  accessibilityRole="button"
                >
                  <Text numberOfLines={1} className="flex-1 pr-3">
                    {chapterLabel(c.chapter)}
                    {i === 0 ? t('player.sleepTimer.current') : ''}
                  </Text>
                  <Text variant="caption" style={TABULAR}>
                    {formatCountdown(c.untilEnd)}
                  </Text>
                </AnimatedPressable>
              ))}
            </ScrollView>
          </View>
        ) : nowPlaying ? (
          <AnimatedPressable
            onPress={() => pick(() => startUntilPosition(total, t('player.sleepTimer.endOfBook')))}
            className="flex-row items-center justify-between rounded-lg bg-gray-100 px-4 py-3 dark:bg-gray-860"
            accessibilityRole="button"
          >
            <Text>{t('player.sleepTimer.endOfBook')}</Text>
            <Text variant="caption" style={TABULAR}>
              {formatCountdown(wallClockSeconds(total - bookPosition, rate))}
            </Text>
          </AnimatedPressable>
        ) : (
          <Text variant="caption">{t('player.sleepTimer.noChapters')}</Text>
        )}

        {active ? (
          <AnimatedPressable
            onPress={() => pick(cancel)}
            className="mt-1 items-center rounded-lg bg-primary px-4 py-3"
            accessibilityRole="button"
          >
            <RNText className="font-roboto-semibold text-base text-white dark:text-white">
              {t('player.sleepTimer.cancel')}
            </RNText>
          </AnimatedPressable>
        ) : null}
      </View>
    </Sheet>
  );
}
