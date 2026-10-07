import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type DimensionValue, Platform, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { BookCover } from '@/components/library/book-cover';
import { ChapterProgressLine } from '@/components/player/chapter-progress';
import { SkipButton } from '@/components/player/skip-button';
import { PlayButton } from '@/components/player/transport-controls';
import { useSleepCountdown } from '@/components/player/use-sleep-countdown';
import { usePlayingTimeLeft } from '@/components/player/use-time-left';
import { ACCESSORY_SUPPORTED } from '@/components/shell/accessory-support';
import { useChromeEdge, useShellMetrics } from '@/components/shell/shell-metrics';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { selectCurrentChapter, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** The card's height (STYLEGUIDE "Mini player": 56). */
export const MINI_PLAYER_HEIGHT = 56;
/** The gap between the card and the tab bar under it. */
export const MINI_PLAYER_GAP = 6;
/** The base bottom padding the scroll screens already carry (their `p-4`). */
const BASE_CONTENT_PADDING = 16;
/** The cover's side. */
const COVER = 42;

/**
 * Bottom padding a scrollable screen should give its scroll content so the last row
 * clears the floating mini player. The card is absolutely positioned and content
 * scrolls *behind* it, so without this the final items sit underneath it. Returns just
 * the normal base padding when nothing is loaded, on tablet/desktop (the docked player
 * bar sits in the layout, below the page), and in the iOS 26 tab bar accessory (part
 * of the native bar, which the system already insets scroll content for).
 */
export function useMiniPlayerInset(): number {
  const loaded = usePlayer((s) => s.nowPlaying != null);
  const phone = useLayout() === 'phone';
  const floating = loaded && phone && !ACCESSORY_SUPPORTED;
  return BASE_CONTENT_PADDING + (floating ? MINI_PLAYER_HEIGHT + MINI_PLAYER_GAP : 0);
}

/** The native phone's floating mini player (Android, iOS before 26): ONE card for the
 * whole shell, rendered by the `(app)` layout over NativeTabs rather than once per tab
 * stack (NativeTabs keeps visited tabs alive, so a card per stack meant up to five ticking
 * instances, each replaying its entrance on a tab's first visit). Its bottom edge sits on
 * the native bar's measured top edge (`bar`, published by the tab stacks), so it waits for
 * that first measure rather than flashing over the bar. */
export function FloatingMiniPlayer() {
  const bar = useShellMetrics((s) => s.edges.bar);
  return bar === undefined ? null : <MiniPlayer bottomOffset={bar} />;
}

/**
 * The compact players' second line (the mini card and the iOS accessory pill): the book
 * and its time left at the listener's speed ("The Way of Kings · 22h 27m left at
 * 1.25×"), or with a sleep timer counting down, the countdown first, after the moon
 * ("12:04 · The Way of Kings · ..."). `showTitle: false` drops the book (a chapterless book's heading is
 * already its title). Leaves re-render only when their text changes.
 */
export function MiniPlayerSubtitle({
  title,
  showTitle = true,
}: {
  title: string;
  showTitle?: boolean;
}) {
  const themed = useThemeColors();
  const left = usePlayingTimeLeft();
  const sleep = useSleepCountdown();
  const rest = [showTitle ? title : '', left].filter(Boolean).join(' · ');
  return (
    <View className="flex-row items-center gap-1">
      {sleep ? (
        <View testID="mini-sleep" className="flex-row items-center gap-1">
          <Icon name="sleep" size={11} color={themed.foreground} />
          <Text
            variant="caption"
            className="font-sans-semibold text-foreground"
            style={tabularNums}
          >
            {rest ? `${sleep} ·` : sleep}
          </Text>
        </View>
      ) : null}
      {rest ? (
        <Text variant="caption" numberOfLines={1} className="flex-1" style={tabularNums}>
          {rest}
        </Text>
      ) : null}
    </View>
  );
}

/** The heading the compact players show: the current chapter, else the book's title. */
export function useMiniHeading(): { heading: string; isChapter: boolean } {
  const { t } = useTranslation();
  const title = usePlayer((s) => s.nowPlaying?.title ?? '');
  const chapter = usePlayer(selectCurrentChapter);
  const label = chapter ? chapterLabel(chapter, t) : '';
  return label ? { heading: label, isChapter: true } : { heading: title, isChapter: false };
}

/**
 * The phone mini player card (STYLEGUIDE "Mini player"), shown whenever something is
 * loaded, wherever the native tab bar can't host it (web, Android, iOS before 26 - see
 * `ACCESSORY_SUPPORTED`): a 56 pt card inset 8 from the screen's sides and floating
 * `MINI_PLAYER_GAP` above the tab bar, with the cover, the chapter, the book with its
 * time left (the sleep countdown first while a timer runs), skip back, play/pause
 * (spinner while loading, Retry after an error) and a 2.5 px chapter progress line along
 * its bottom. The cover and text open the full player.
 *
 * `bottomOffset` puts the card's bottom on the bar's top edge within its parent (native:
 * the measured bar edge; web: `100%` of the wrapper around our tab bar). Content scrolls
 * behind it; screens reserve room with `useMiniPlayerInset()`. It publishes its top edge
 * (the bar's, plus the gap and its own height) for the root toasts.
 */
export function MiniPlayer({ bottomOffset = 0 }: { bottomOffset?: DimensionValue }) {
  const themed = useThemeColors();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipBackward = useSettings((s) => s.skipBackward);
  const { heading, isChapter } = useMiniHeading();
  const { t } = useTranslation();
  const reduced = useReducedMotion();

  // Slide-up + fade entrance driven off the card's presence transition. The component
  // mounts early and renders null until a book is playing, so anchoring the animation
  // to mount would leave `enter` already at 1 by the time the card actually appears
  // mid-session. Instead reset to 0 and animate to 1 only when `nowPlaying` goes from
  // falsy to truthy - not on track/progress changes.
  const visible = nowPlaying != null;
  const bar = useShellMetrics((s) => s.edges.bar);
  const [height, setHeight] = useState<number>();
  useChromeEdge(
    'mini',
    visible && bar !== undefined && height !== undefined
      ? bar + MINI_PLAYER_GAP + height
      : undefined,
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

  return (
    <Animated.View
      testID="mini-player"
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      style={[
        {
          position: 'absolute',
          left: 8,
          right: 8,
          bottom: bottomOffset,
          marginBottom: MINI_PLAYER_GAP,
          height: MINI_PLAYER_HEIGHT,
        },
        entranceStyle,
      ]}
    >
      {/* Opaque (scrolling covers never bleed through), a hairline and the overlay
          shadow (Android: elevation, which keeps it lifted on the porcelain page). */}
      <View
        testID="mini-player-card"
        className="flex-1 flex-row items-center gap-1 rounded-card border border-border bg-card pl-[7px] pr-1.5 shadow-overlay"
      >
        <AnimatedPressable
          onPress={() => router.push('/player')}
          accessibilityRole="button"
          accessibilityLabel={t('shell.openPlayer', { title: nowPlaying.title })}
          className={cn(
            'min-w-0 flex-1 flex-row items-center gap-2.5 self-stretch rounded-control',
            Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
          )}
        >
          <BookCover
            connectionId={nowPlaying.connectionId}
            libraryId={nowPlaying.libraryId}
            path={nowPlaying.path}
            width={COVER}
            title={nowPlaying.title}
          />
          <View className="min-w-0 flex-1">
            <Text variant="label" className="text-[13.5px] leading-[17px]" numberOfLines={1}>
              {heading}
            </Text>
            <MiniPlayerSubtitle title={nowPlaying.title} showTitle={isChapter} />
          </View>
        </AnimatedPressable>
        <SkipButton
          direction="back"
          seconds={skipBackward}
          onPress={() => void skipSeconds(-skipBackward)}
          color={themed.foreground}
          fontSize={13}
          hitSlop={2}
          className={cn(
            'h-10 w-10 items-center justify-center rounded-full active:bg-accent',
            Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
          )}
          accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
        />
        <PlayButton size="sm" plain />
        {/* The chapter progress along the card's bottom edge, inset from its corners. */}
        <ChapterProgressLine className="absolute bottom-[3px] left-3.5 right-3.5" />
      </View>
    </Animated.View>
  );
}
