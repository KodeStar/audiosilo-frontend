import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type DimensionValue, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useApi } from '@/api/provider';
import { BookProgressLine, useBookTimeLeft } from '@/components/player/book-progress';
import { SkipButton } from '@/components/player/skip-button';
import { ACCESSORY_SUPPORTED } from '@/components/shell/accessory-support';
import { useChromeEdge, useShellMetrics } from '@/components/shell/shell-metrics';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { useLayout } from '@/lib/layout';
import { selectCurrentChapter, selectIsPlaying, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Height of the flush cover square, which is also the bar's content-row height. */
const COVER_SIZE = 64;
/** Approximate rendered height of the docked bar (cover 64 + 2px progress hairline). */
const MINI_PLAYER_HEIGHT = 66;
/** The base bottom padding the scroll screens already carry (their `p-4`). */
const BASE_CONTENT_PADDING = 16;

/**
 * Bottom padding a scrollable screen should give its scroll content so the last row
 * clears the floating mini player. The bar is absolutely positioned and content
 * scrolls *behind* it, so without this the final items sit underneath it. Returns just
 * the normal base padding when nothing is loaded, on tablet/desktop (the docked player
 * bar sits in the layout, below the page), and in the iOS 26 tab bar accessory (part
 * of the native bar, which the system already insets scroll content for).
 */
export function useMiniPlayerInset(): number {
  const loaded = usePlayer((s) => s.nowPlaying != null);
  const phone = useLayout() === 'phone';
  const floating = loaded && phone && !ACCESSORY_SUPPORTED;
  return BASE_CONTENT_PADDING + (floating ? MINI_PLAYER_HEIGHT : 0);
}

/** "5h 27m left (1.4×)" - wall-clock time remaining at the current speed, with the
 * speed modifier appended. A leaf so only this line re-renders, when its text changes. */
function TimeLeft({ total }: { total: number }) {
  const { t } = useTranslation();
  const time = useBookTimeLeft(total);
  const rate = usePlayer((s) => s.rate);
  if (!time) return null;
  const rateLabel = `${Number(rate.toFixed(2))}×`;
  return (
    <Text variant="caption" numberOfLines={1} style={tabularNums}>
      {t('player.controls.timeLeft', { time, rate: rateLabel })}
    </Text>
  );
}

/** The phone mini player, shown whenever something is loaded, wherever the native tab
 * bar can't host it (web, Android, iOS before 26 - see `ACCESSORY_SUPPORTED`). Tap to
 * open the full player. It sits flush on top of the tab bar: `bottomOffset` puts its
 * bottom edge on the bar's top edge within its parent (which includes the home-indicator
 * safe-area inset, so a fixed offset would leave the bar hidden behind it). Content
 * scrolls behind it; screens reserve room with `useMiniPlayerInset()`. It publishes its
 * top edge (the bar's, plus its own height) for the root toasts. */
export function MiniPlayer({ bottomOffset = 0 }: { bottomOffset?: DimensionValue }) {
  const themed = useThemeColors();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const isPlaying = usePlayer(selectIsPlaying);
  const currentChapter = usePlayer(selectCurrentChapter);
  const toggle = usePlayer((s) => s.toggle);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipBackward = useSettings((s) => s.skipBackward);
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
  const bar = useShellMetrics((s) => s.edges.bar);
  const [height, setHeight] = useState<number>();
  useChromeEdge(
    'mini',
    visible && bar !== undefined && height !== undefined ? bar + height : undefined,
  );
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
  const caption = (currentChapter ? chapterLabel(currentChapter, t) : '') || nowPlaying.author;

  return (
    <Animated.View
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      style={[{ position: 'absolute', left: 0, right: 0, bottom: bottomOffset }, entranceStyle]}
    >
      {/* Fully opaque so scrolling covers never bleed through the bar. Flush full
          width and docked directly on top of the nav below - a top hairline border
          separates it from the scrolling content, the progress bar (below) from the
          nav. */}
      <AnimatedPressable
        onPress={() => router.push('/player')}
        className="overflow-hidden border-t border-border bg-card"
        accessibilityRole="button"
        accessibilityLabel={nowPlaying.title}
      >
        {/* Cover sits flush against the bar's left edge, full content-row height - the
            artwork anchors the bar. */}
        <View className="flex-row items-stretch bg-card">
          <Cover
            source={{ uri: nowPlaying.cover, headers: api.authHeaders() }}
            label={nowPlaying.title}
            rounded="rounded-none"
            size={COVER_SIZE}
          />
          <View className="flex-1 flex-row items-center gap-3 px-3">
            <View className="flex-1">
              <Text variant="label" numberOfLines={1}>
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
              color={themed.mutedForeground}
              fontSize={12}
              className="px-1 items-center justify-center"
              accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
            />
            <AnimatedPressable
              onPress={() => void toggle()}
              hitSlop={8}
              // Ink, like every play button: the progress hairline is this bar's pink.
              className={`h-10 w-10 items-center justify-center rounded-full bg-primary ${
                isPlaying ? '' : 'pl-0.5'
              }`}
              accessibilityRole="button"
              accessibilityLabel={
                isPlaying ? t('player.controls.pause') : t('player.controls.play')
              }
            >
              <Icon
                name={isPlaying ? 'pause' : 'play'}
                size={18}
                color={themed.primaryForeground}
              />
            </AnimatedPressable>
          </View>
        </View>
        {/* The 2px whole-book hairline along the bar's BOTTOM edge, flush on the nav
            below. A leaf: the bar around it reconciles only on play/pause/track. */}
        <BookProgressLine total={nowPlaying.queue.total} className="h-0.5 bg-muted" />
      </AnimatedPressable>
    </Animated.View>
  );
}
