import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useApi } from '@/api/provider';
import { SkipButton } from '@/components/player/skip-button';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { WIDE_BREAKPOINT } from '@/lib/layout';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { wallClockSeconds } from '@/playback/rate';
import {
  selectBookPosition,
  selectCurrentChapter,
  selectIsPlaying,
  usePlayer,
} from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme/theme-provider';
import { colors, tabularNums } from '@/theme/tokens';

/** Height of the flush cover square, which is also the bar's content-row height. */
const COVER_SIZE = 64;
/** Approximate rendered height of the docked bar (cover 64 + 2px progress hairline). */
const MINI_PLAYER_HEIGHT = 66;
/** The base bottom padding the scroll screens already carry (their `p-4`). */
const BASE_CONTENT_PADDING = 16;

/**
 * Bottom padding a scrollable phone screen should give its scroll content so the
 * last row clears the docked mini-player. The bar is absolutely positioned and
 * content scrolls *behind* it, so without this the final items sit underneath it.
 * Returns just the normal base padding when nothing is docked, or on wide layouts
 * where the player is a side panel rather than a docked bar.
 */
export function useMiniPlayerInset(): number {
  const docked = usePlayer((s) => s.nowPlaying != null);
  const { width } = useWindowDimensions();
  const floating = docked && width < WIDE_BREAKPOINT;
  return BASE_CONTENT_PADDING + (floating ? MINI_PLAYER_HEIGHT : 0);
}

/** The 2px whole-book progress hairline along the bar's BOTTOM edge, so it sits
 * flush on top of the nav bar below. It subscribes to the per-tick playback
 * position on its own, so only this leaf re-renders each tick - the always-mounted
 * bar around it reconciles just on play/pause/track changes. */
function ProgressHairline({ total }: { total: number }) {
  const bookPosition = usePlayer(selectBookPosition);
  const fraction = total > 0 ? Math.max(0, Math.min(1, bookPosition / total)) : 0;
  return (
    <View className="h-0.5 bg-gray-300 dark:bg-gray-750">
      <View className="h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
    </View>
  );
}

/** "5h 27m left (1.4×)" - wall-clock time remaining at the current speed, with the
 * speed modifier appended. A leaf so only this line re-renders as the position
 * ticks (it reads the live whole-book position + rate from the store). */
function TimeLeft({ total }: { total: number }) {
  const { t } = useTranslation();
  const position = usePlayer(selectBookPosition);
  const rate = usePlayer((s) => s.rate);
  const remaining = wallClockSeconds(total - position, rate);
  if (remaining <= 0) return null;
  const rateLabel = `${Number(rate.toFixed(2))}×`;
  return (
    <Text variant="caption" numberOfLines={1} style={tabularNums}>
      {t('player.controls.timeLeft', { time: formatDuration(remaining), rate: rateLabel })}
    </Text>
  );
}

/** Docked transport bar shown whenever something is loaded. Tap to open the full
 * player. It sits flush on top of the bottom nav - `bottomOffset` is the nav's
 * measured height (which on iOS includes the home-indicator safe-area inset, so a
 * fixed offset would leave the bar hidden behind it). Content scrolls behind it;
 * screens reserve room with `useMiniPlayerInset()`. */
export function MiniPlayer({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const isPlaying = usePlayer(selectIsPlaying);
  const currentChapter = usePlayer(selectCurrentChapter);
  const toggle = usePlayer((s) => s.toggle);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipBackward = useSettings((s) => s.skipBackward);
  const { scheme } = useTheme();
  // The cover URL embeds the playing book's own server auth (`?token=`); its request
  // headers must match that connection too, not whatever happens to be default - the
  // mini-player can outlive a switch away from the connection the book plays through.
  const api = useApi(nowPlaying?.connectionId);
  const { t } = useTranslation();
  const reduced = useReducedMotion();

  // Slide-up + fade entrance driven off the bar's presence transition. The
  // component mounts early and renders null until a book is playing, so anchoring
  // the animation to mount would leave `enter` already at 1 by the time the bar
  // actually appears mid-session. Instead reset to 0 and animate to 1 only when
  // `nowPlaying` goes from falsy to truthy - not on track/progress changes.
  const visible = nowPlaying != null;
  const wasVisible = useRef(false);
  const enter = useSharedValue(0);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      enter.value = 0;
      enter.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) });
    }
    wasVisible.current = visible;
  }, [visible, enter]);
  const entranceStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: reduced ? [] : [{ translateY: (1 - enter.value) * 16 }],
  }));

  if (!nowPlaying) return null;

  // Muted caption line: the current chapter (prettified, like the full player) when the
  // book carries chapters, else the author. Display-only - reads from the store.
  const chapterLabel = currentChapter
    ? prettifyChapterTitle(
        currentChapter.title ||
          t('player.chapters.chapterNumber', { number: currentChapter.index + 1 }),
      )
    : '';
  const caption = chapterLabel || nowPlaying.author;

  return (
    <Animated.View
      style={[{ position: 'absolute', left: 0, right: 0, bottom: bottomOffset }, entranceStyle]}
    >
      {/* Fully opaque so scrolling covers never bleed through the bar. Flush full
          width and docked directly on top of the nav below - a top hairline border
          separates it from the scrolling content, the progress bar (below) from the
          nav. */}
      <AnimatedPressable
        onPress={() => router.push('/player')}
        className="overflow-hidden border-t border-gray-100 bg-gray-50 dark:border-gray-750 dark:bg-gray-840"
        accessibilityRole="button"
        accessibilityLabel={nowPlaying.title}
      >
        {/* Cover sits flush against the bar's left edge, full content-row height - the
            artwork anchors the bar. */}
        <View className="flex-row items-stretch bg-gray-50 dark:bg-gray-840">
          <Cover
            source={{ uri: nowPlaying.cover, headers: api.authHeaders() }}
            label={nowPlaying.title}
            rounded="rounded-none"
            size={COVER_SIZE}
          />
          <View className="flex-1 flex-row items-center gap-3 px-3">
            <View className="flex-1">
              <Text variant="subtitle" numberOfLines={1}>
                {nowPlaying.title}
              </Text>
              {caption ? (
                <Text variant="caption" numberOfLines={1}>
                  {caption}
                </Text>
              ) : null}
              <TimeLeft total={nowPlaying.queue.total} />
            </View>
            <SkipButton
              direction="back"
              seconds={skipBackward}
              onPress={() => void skipSeconds(-skipBackward)}
              color={colors[scheme].textMuted}
              fontSize={12}
              className="px-1 items-center justify-center"
              accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
            />
            <AnimatedPressable
              onPress={() => void toggle()}
              hitSlop={8}
              className={`h-10 w-10 items-center justify-center rounded-full bg-primary ${
                isPlaying ? '' : 'pl-0.5'
              }`}
              accessibilityRole="button"
              accessibilityLabel={
                isPlaying ? t('player.controls.pause') : t('player.controls.play')
              }
            >
              <Icon name={isPlaying ? 'pause' : 'play'} size={18} color={colors.white} />
            </AnimatedPressable>
          </View>
        </View>
        <ProgressHairline total={nowPlaying.queue.total} />
      </AnimatedPressable>
    </Animated.View>
  );
}
