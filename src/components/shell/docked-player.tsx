import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApi } from '@/api/provider';
import { useReachability } from '@/api/reachability';
import { SeekBar } from '@/components/player/seek-bar';
import { SkipButton } from '@/components/player/skip-button';
import { SleepSheet, SleepTimerButton } from '@/components/player/sleep-timer-button';
import { SpeedButton, SpeedSheet } from '@/components/player/speed-button';
import {
  currentSegment,
  nextSegmentStart,
  previousSegmentStart,
  segmentStarts,
} from '@/components/player/transport';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatClock, formatDuration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { wallClockSeconds } from '@/playback/rate';
import {
  selectBookPosition,
  selectCurrentChapter,
  selectIsPlaying,
  usePlayer,
} from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { setShellMetric } from './shell-metrics';

/** The 3px whole-book progress line along the bar's top edge. A leaf: it subscribes to
 * the per-tick position so the rest of the bar re-renders only on real changes. */
function BookProgressLine({ total }: { total: number }) {
  const position = usePlayer(selectBookPosition);
  const fraction = total > 0 ? Math.max(0, Math.min(1, position / total)) : 0;
  return (
    <View className="absolute left-0 right-0 top-0 h-[3px]">
      <View className="h-full bg-brand" style={{ width: `${fraction * 100}%` }} />
    </View>
  );
}

/** The chapter scrubber row: elapsed in the chapter, the scrubber, and the time left in
 * the whole book at the listener's speed. A per-tick leaf. */
function ChapterScrubber({ total }: { total: number }) {
  const { t } = useTranslation();
  const bookPosition = usePlayer(selectBookPosition);
  const chapter = usePlayer(selectCurrentChapter);
  const trackPosition = usePlayer((s) => s.snapshot.position);
  const trackDuration = usePlayer((s) => s.snapshot.duration);
  const rate = usePlayer((s) => s.rate);
  const seekBook = usePlayer((s) => s.seekBook);
  const seekInTrack = usePlayer((s) => s.seekInTrack);
  const [scrub, setScrub] = useState<number | null>(null);
  const segment = currentSegment({ total, bookPosition, chapter, trackPosition, trackDuration });
  const left = wallClockSeconds(total - bookPosition, rate);
  const onSeek = (p: number) =>
    segment.perTrack ? void seekInTrack(p) : void seekBook(segment.start + p);
  return (
    <View className="-my-2.5 flex-row items-center gap-2.5">
      <Text variant="caption" style={tabularNums} className="min-w-[44px] text-right">
        {formatClock(scrub ?? segment.elapsed)}
      </Text>
      <View className="flex-1">
        <SeekBar
          position={segment.elapsed}
          duration={segment.length}
          onSeek={onSeek}
          onScrub={setScrub}
          tone="ink"
        />
      </View>
      <Text variant="caption" style={tabularNums} className="min-w-[44px]" numberOfLines={1}>
        {total > 0 && left > 0 ? t('shell.dock.bookLeft', { time: formatDuration(left) }) : ''}
      </Text>
    </View>
  );
}

/** Where progress lives, when it isn't simply syncing: the server is unreachable, so the
 * place is kept on this device (STYLEGUIDE section 9, "reliability shown"). */
function SyncState({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const offline = useReachability((s) => s.online[connectionId] === false);
  if (!offline) return null;
  return (
    <View className="flex-row items-center gap-1">
      <Icon name="offline" size={11} color={themed.subtleForeground} />
      <Text variant="caption" className="text-[11px] text-subtle-foreground" numberOfLines={1}>
        {t('shell.dock.savedLocally')}
      </Text>
    </View>
  );
}

type DockSheet = 'speed' | 'sleep' | null;

/**
 * The docked player bar (84, STYLEGUIDE section 8) on tablet and desktop, whenever a
 * book is loaded: a whole-book progress line on top; the cover, chapter and book on the
 * left (tap for the full player); previous chapter / back / play / forward / next
 * chapter over a chapter scrubber in the centre; speed, sleep and expand on the right.
 *
 * Renders a fragment: the bar, then its speed and sleep sheets, so the sheets (which
 * render in place, `absolute inset-0`) are siblings of the bar in the shell's root
 * column and cover the whole app. Mount it as a direct child of that root.
 */
export function DockedPlayer() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const insets = useSafeAreaInsets();
  const desktop = useLayout() === 'desktop';
  const [sheet, setSheet] = useState<DockSheet>(null);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const chapter = usePlayer(selectCurrentChapter);
  const isPlaying = usePlayer(selectIsPlaying);
  const state = usePlayer((s) => s.snapshot.state);
  const toggle = usePlayer((s) => s.toggle);
  const retry = usePlayer((s) => s.retry);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const api = useApi(nowPlaying?.connectionId);
  if (!nowPlaying) return null;

  const { queue, title, author } = nowPlaying;
  const heading = chapter
    ? prettifyChapterTitle(
        chapter.title || t('player.chapters.chapterNumber', { number: chapter.index + 1 }),
      )
    : title;
  const bookLine = author ? `${title} · ${author}` : title;
  const openPlayer = () => router.push('/player');

  // Previous/next read the live position at press time (not per render), the same rules
  // as the full player: by chapter, by file without a whole-book timeline.
  const step = (dir: 1 | -1) => {
    const s = usePlayer.getState();
    if (queue.total <= 0) {
      const i = s.snapshot.trackIndex;
      if (dir === -1 && s.snapshot.position > 3) return void s.seekInTrack(0);
      return void s.goToTrack(i + dir);
    }
    const position = selectBookPosition(s);
    const starts = segmentStarts(queue);
    const target =
      dir === 1 ? nextSegmentStart(starts, position) : previousSegmentStart(starts, position);
    if (target !== undefined) void s.seekBook(target);
  };

  const isError = state === 'error';
  const roundButton = 'h-10 w-10 items-center justify-center rounded-full active:bg-accent';

  return (
    <>
      <View
        testID="shell-docked-player"
        accessibilityLabel={t('shell.dock.label')}
        // The root toast host sits above the bar (`ShellToastHost`).
        onLayout={(e) => setShellMetric('dockHeight', e.nativeEvent.layout.height)}
        style={{
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
        className="border-t border-border bg-card"
      >
        <BookProgressLine total={queue.total} />
        <View className="h-[84px] flex-row items-center gap-4 pl-3.5 pr-4 lg:gap-5 lg:pr-5">
          <AnimatedPressable
            onPress={openPlayer}
            accessibilityRole="button"
            accessibilityLabel={t('shell.openPlayer', { title })}
            className="flex-1 flex-row items-center gap-3 rounded-[14px] p-1.5 active:bg-accent"
          >
            <Cover
              source={{ uri: nowPlaying.cover, headers: api.authHeaders() }}
              label={title}
              rounded="rounded-[4px]"
              size={desktop ? 56 : 48}
            />
            <View className="flex-1">
              <Text className="font-sans-bold text-sm" numberOfLines={1}>
                {heading}
              </Text>
              <Text variant="caption" numberOfLines={1}>
                {bookLine}
              </Text>
              <SyncState connectionId={nowPlaying.connectionId} />
            </View>
          </AnimatedPressable>

          <View className="flex-[1.4] justify-center">
            <View className="flex-row items-center justify-center gap-1.5">
              <AnimatedPressable
                onPress={() => step(-1)}
                accessibilityRole="button"
                accessibilityLabel={t('player.controls.previous')}
                className={roundButton}
              >
                <Icon name="prev" size={16} color={themed.foreground} />
              </AnimatedPressable>
              <SkipButton
                direction="back"
                seconds={skipBackward}
                onPress={() => void skipSeconds(-skipBackward)}
                color={themed.foreground}
                fontSize={13}
                className={roundButton}
                accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
              />
              <AnimatedPressable
                onPress={() => (isError ? void retry() : void toggle())}
                accessibilityRole="button"
                accessibilityLabel={
                  isError
                    ? t('common.retry')
                    : isPlaying
                      ? t('player.controls.pause')
                      : t('player.controls.play')
                }
                className={`h-[44px] w-[44px] items-center justify-center rounded-full bg-primary ${
                  isPlaying ? '' : 'pl-0.5'
                }`}
              >
                {state === 'loading' ? (
                  <Spinner color={themed.primaryForeground} />
                ) : (
                  <Icon
                    name={isError ? 'circle-play' : isPlaying ? 'pause' : 'play'}
                    size={18}
                    color={themed.primaryForeground}
                  />
                )}
              </AnimatedPressable>
              <SkipButton
                direction="forward"
                seconds={skipForward}
                onPress={() => void skipSeconds(skipForward)}
                color={themed.foreground}
                fontSize={13}
                className={roundButton}
                accessibilityLabel={t('player.controls.skipForward', { seconds: skipForward })}
              />
              <AnimatedPressable
                onPress={() => step(1)}
                accessibilityRole="button"
                accessibilityLabel={t('player.controls.next')}
                className={roundButton}
              >
                <Icon name="next" size={16} color={themed.foreground} />
              </AnimatedPressable>
            </View>
            <ChapterScrubber total={queue.total} />
          </View>

          <View className="flex-1 flex-row items-center justify-end gap-3">
            <SpeedButton onPress={() => setSheet('speed')} />
            <SleepTimerButton onPress={() => setSheet('sleep')} />
            <AnimatedPressable
              onPress={openPlayer}
              accessibilityRole="button"
              accessibilityLabel={t('shell.dock.expand')}
              className="h-9 w-9 items-center justify-center rounded-[10px] active:bg-accent"
            >
              <Icon name="chevron-up" size={18} color={themed.foreground} />
            </AnimatedPressable>
          </View>
        </View>
      </View>
      <SpeedSheet visible={sheet === 'speed'} onClose={() => setSheet(null)} />
      <SleepSheet visible={sheet === 'sleep'} onClose={() => setSheet(null)} />
    </>
  );
}
