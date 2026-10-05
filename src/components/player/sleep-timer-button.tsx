import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, Text as RNText, View } from 'react-native';

import type { Chapter } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { formatClock, formatCountdown } from '@/lib/format';
import { chapterCountdowns } from '@/playback/book-queue';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { wallClockSeconds } from '@/playback/rate';
import {
  chapterSleepLabel,
  selectSleepExtendable,
  selectSleepPhase,
  useSleepTimer,
} from '@/playback/sleep-timer';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { tabularNums } from '@/theme/tabular-nums';
import { colors } from '@/theme/tokens';

const PRESETS = [5, 10, 15, 20, 30, 45, 60];

/**
 * Sleep-timer trigger. Shows the current remaining time when active, and swaps to a
 * "keep going" prompt once the timer is about to stop or has just paused playback -
 * the two windows where opening the sheet still keeps the listener going. The sheet
 * itself (`SleepSheet`) is mounted at the player root so the shared bottom `Sheet`
 * presents correctly.
 */
export function SleepTimerButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const phase = useSleepTimer(selectSleepPhase);
  // The a11y label follows what the button can DO, not merely whether a timer exists:
  // it overrides the visible children for a screen reader, and announcing "Keep
  // listening" for a control that just opens the presets sheet (25 minutes still to
  // run) is simply wrong. The same selector gates the shake listener, so the spoken
  // promise and the gesture are true in exactly the same windows.
  const extendable = useSleepTimer(selectSleepExtendable);
  const remaining = useSleepTimer((s) => s.remaining);
  // Match the sibling footer icons' theme-aware neutral (history/airplay use the
  // same `textStrong`); a hardcoded dark color washed out on the light footer.
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;

  return (
    <AnimatedPressable
      onPress={onPress}
      className="flex-row items-center gap-1.5"
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        extendable ? t('player.sleepTimer.keepListening') : t('player.sleepTimer.title')
      }
    >
      <Icon name="sleep" size={20} color={phase === 'idle' ? neutral : colors.primary} />
      {phase === 'grace' ? (
        <RNText className="font-roboto-semibold text-sm text-primary">
          {t('player.sleepTimer.keepGoingShort')}
        </RNText>
      ) : phase !== 'idle' && remaining !== null ? (
        // Ending: the same countdown, weighted up so a glance reads "about to stop".
        <RNText
          className={`text-sm text-primary ${
            phase === 'ending' ? 'font-roboto-semibold' : 'font-sans'
          }`}
          style={tabularNums}
        >
          {formatClock(remaining)}
        </RNText>
      ) : null}
    </AnimatedPressable>
  );
}

/**
 * The sleep-timer presets / end-of-chapter sheet, controlled by the player.
 * The body (which subscribes to the per-tick playback position and recomputes the
 * chapter countdowns) lives in a child of `Sheet`, so it only mounts while the sheet
 * is open - `Sheet` renders no children when closed, so the countdown scan and its
 * per-tick re-render don't run for the whole session behind a closed sheet.
 */
export function SleepSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet inline visible={visible} onClose={onClose} title={t('player.sleepTimer.title')}>
      <SleepSheetBody onClose={onClose} />
    </Sheet>
  );
}

function SleepSheetBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const chapterLabel = (ch: Chapter) =>
    prettifyChapterTitle(ch.title || t('player.chapters.chapterNumber', { number: ch.index + 1 }));
  const phase = useSleepTimer(selectSleepPhase);
  const label = useSleepTimer((s) => s.label);
  const remaining = useSleepTimer((s) => s.remaining);
  // Only a duration timer fades out (see `fadesAudio` in sleep-timer.ts), so only it
  // may say so: a chapter timer plays its last 30 seconds at full volume.
  const origin = useSleepTimer((s) => s.origin);
  const startDuration = useSleepTimer((s) => s.startDuration);
  const startUntilPosition = useSleepTimer((s) => s.startUntilPosition);
  const keepListening = useSleepTimer((s) => s.keepListening);
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
    <View className="gap-3 px-4 pb-4">
      {phase === 'ending' || phase === 'grace' ? (
        // The extendable windows. The button is mandatory, not a convenience: the web
        // has no accelerometer, so it is the only way to keep listening there. On
        // native it sits alongside the shake hint.
        <View className="gap-2 rounded-lg bg-primary/10 px-3 py-3">
          <View className="flex-row items-center justify-between">
            <RNText className="font-roboto-semibold text-base text-primary">
              {phase === 'grace'
                ? t('player.sleepTimer.grace')
                : origin?.kind === 'duration'
                  ? t('player.sleepTimer.fading')
                  : t('player.sleepTimer.ending')}
            </RNText>
            {remaining !== null ? (
              <RNText className="font-roboto-semibold text-base text-primary" style={tabularNums}>
                {formatClock(remaining)}
              </RNText>
            ) : null}
          </View>
          {Platform.OS === 'web' ? null : (
            <Text variant="caption">{t('player.sleepTimer.shakeHint')}</Text>
          )}
          <AnimatedPressable
            onPress={() => pick(keepListening)}
            className="items-center rounded-lg bg-primary px-4 py-3"
            accessibilityRole="button"
          >
            <RNText className="font-roboto-semibold text-base text-white dark:text-white">
              {t('player.sleepTimer.keepListening')}
            </RNText>
          </AnimatedPressable>
        </View>
      ) : phase === 'running' ? (
        <View className="flex-row items-center justify-between rounded-lg bg-primary/10 px-3 py-2">
          <RNText className="font-sans text-base text-primary">
            {/* Rendered here, not stored: the timer keeps a translation descriptor so
                a language switch re-renders an armed timer in the new language. */}
            {label ? t(label.key, label.params) : t('player.sleepTimer.running')}
          </RNText>
          {remaining !== null ? (
            <RNText className="font-roboto-semibold text-base text-primary" style={tabularNums}>
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
            <Text style={tabularNums}>{t('player.sleepTimer.minutes', { count: m })}</Text>
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
                  pick(() => startUntilPosition(c.endPosition, chapterSleepLabel(c.chapter)))
                }
                className="flex-row items-center justify-between rounded-lg bg-gray-100 px-4 py-3 dark:bg-gray-860"
                accessibilityRole="button"
              >
                <Text numberOfLines={1} className="flex-1 pr-3">
                  {chapterLabel(c.chapter)}
                  {i === 0 ? t('player.sleepTimer.current') : ''}
                </Text>
                <Text variant="caption" style={tabularNums}>
                  {formatCountdown(c.untilEnd)}
                </Text>
              </AnimatedPressable>
            ))}
          </ScrollView>
        </View>
      ) : nowPlaying ? (
        <AnimatedPressable
          onPress={() =>
            pick(() => startUntilPosition(total, { key: 'player.sleepTimer.endOfBook' }))
          }
          className="flex-row items-center justify-between rounded-lg bg-gray-100 px-4 py-3 dark:bg-gray-860"
          accessibilityRole="button"
        >
          <Text>{t('player.sleepTimer.endOfBook')}</Text>
          <Text variant="caption" style={tabularNums}>
            {formatCountdown(wallClockSeconds(total - bookPosition, rate))}
          </Text>
        </AnimatedPressable>
      ) : (
        <Text variant="caption">{t('player.sleepTimer.noChapters')}</Text>
      )}

      {phase !== 'idle' ? (
        // Demoted to a neutral button while the timer is extendable, so it can't
        // compete with the "keep listening" call to action above it.
        <AnimatedPressable
          onPress={() => pick(cancel)}
          className={`mt-1 items-center rounded-lg px-4 py-3 ${
            phase === 'running' ? 'bg-primary' : 'bg-gray-100 dark:bg-gray-860'
          }`}
          accessibilityRole="button"
        >
          {phase === 'running' ? (
            <RNText className="font-roboto-semibold text-base text-white dark:text-white">
              {t('player.sleepTimer.cancel')}
            </RNText>
          ) : (
            <Text>{t('player.sleepTimer.cancel')}</Text>
          )}
        </AnimatedPressable>
      ) : null}
    </View>
  );
}
