import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Text as RNText, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useApi } from '@/api/provider';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { WIDE_BREAKPOINT } from '@/lib/layout';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import {
  selectBookPosition,
  selectCurrentChapter,
  selectIsPlaying,
  usePlayer,
} from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const NATIVE_BLUR = Platform.OS !== 'web';

/** Height of the flush cover square, which is also the bar's content-row height. */
const COVER_SIZE = 56;
/** Approximate rendered height of the docked bar (cover 56 + 2px hairline + 1px borders). */
const MINI_PLAYER_HEIGHT = 60;
/** Gap kept between the floating bar and the nav below it. */
const MINI_PLAYER_GAP = 8;
/** The base bottom padding the scroll screens already carry (their `p-4`). */
const BASE_CONTENT_PADDING = 16;

/**
 * Bottom padding a scrollable phone screen should give its scroll content so the
 * last row clears the floating mini-player. The bar is absolutely positioned and
 * content scrolls *behind* it, so without this the final items sit underneath it.
 * Returns just the normal base padding when nothing is docked, or on wide layouts
 * where the player is a side panel rather than a floating bar.
 */
export function useMiniPlayerInset(): number {
  const docked = usePlayer((s) => s.nowPlaying != null);
  const { width } = useWindowDimensions();
  const floating = docked && width < WIDE_BREAKPOINT;
  return BASE_CONTENT_PADDING + (floating ? MINI_PLAYER_HEIGHT + MINI_PLAYER_GAP : 0);
}

/** Docked transport bar shown whenever something is loaded. Tap to open the full
 * player. It floats just above the bottom nav - `bottomOffset` is the nav's
 * measured height (which on iOS includes the home-indicator safe-area inset, so a
 * fixed offset would leave the bar hidden behind it). Content scrolls behind it;
 * screens reserve room with `useMiniPlayerInset()`. */
export function MiniPlayer({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const isPlaying = usePlayer(selectIsPlaying);
  const bookPosition = usePlayer(selectBookPosition);
  const currentChapter = usePlayer(selectCurrentChapter);
  const toggle = usePlayer((s) => s.toggle);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipForward = useSettings((s) => s.skipForward);
  // The cover URL embeds the playing book's own server auth (`?token=`); its request
  // headers must match that connection too, not whatever happens to be default - the
  // mini-player can outlive a switch away from the connection the book plays through.
  const api = useApi(nowPlaying?.connectionId);
  const { scheme } = useTheme();
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

  // The translucency that lets the blur show through differs by platform: on
  // native a real BlurView sits behind a light tint; on web `backdrop-blur-sm`
  // (a CSS backdrop-filter, native-ignored) blurs behind a denser `/90` fill.
  const fill = NATIVE_BLUR
    ? 'bg-gray-50/60 dark:bg-gray-840/60'
    : 'bg-gray-50/90 dark:bg-gray-840/90';

  const total = nowPlaying.queue.total;
  const fraction = total > 0 ? Math.max(0, Math.min(1, bookPosition / total)) : 0;

  // Muted caption line: the current chapter (prettified, like the full player) when the
  // book carries chapters, else the author. Display-only - reads from the store.
  const chapterLabel = currentChapter
    ? prettifyChapterTitle(
        currentChapter.title ||
          t('player.chapters.chapterNumber', { number: currentChapter.index + 1 }),
      )
    : '';
  const caption = chapterLabel || nowPlaying.author;
  const skipForwardLabel = `${skipForward}s`;

  return (
    <Animated.View
      style={[
        { position: 'absolute', left: 8, right: 8, bottom: bottomOffset + MINI_PLAYER_GAP },
        entranceStyle,
      ]}
    >
      <AnimatedPressable
        onPress={() => router.push('/player')}
        className="overflow-hidden rounded-lg border border-gray-100 dark:border-gray-750"
        accessibilityRole="button"
        accessibilityLabel={nowPlaying.title}
      >
        {NATIVE_BLUR ? (
          <BlurView
            intensity={40}
            tint={scheme === 'dark' ? 'dark' : 'light'}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        {/* 2px whole-book progress hairline along the top edge. */}
        <View className="h-0.5 bg-gray-300 dark:bg-gray-750">
          <View className="h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
        </View>
        {/* Cover sits flush against the bar's left edge, full content-row height - the
            artwork anchors the bar. The container's overflow-hidden rounds the outer
            corners, so the cover itself is square (rounded-none). */}
        <View className={`flex-row items-stretch backdrop-blur-sm ${fill}`}>
          <Cover
            source={{ uri: nowPlaying.cover, headers: api.authHeaders() }}
            label={nowPlaying.title}
            rounded="rounded-none"
            size={COVER_SIZE}
          />
          <View className="flex-1 flex-row items-center gap-2 px-3">
            <View className="flex-1">
              <Text variant="subtitle" numberOfLines={1}>
                {nowPlaying.title}
              </Text>
              {caption ? (
                <Text variant="caption" numberOfLines={1}>
                  {caption}
                </Text>
              ) : null}
            </View>
            <AnimatedPressable
              onPress={() => void skipSeconds(skipForward)}
              hitSlop={8}
              className="h-10 w-10 items-center justify-center"
              accessibilityRole="button"
              accessibilityLabel={t('player.controls.skipForward', { seconds: skipForward })}
            >
              <RNText className="font-roboto-semibold text-[13px] text-primary">
                {skipForwardLabel}
              </RNText>
            </AnimatedPressable>
            <AnimatedPressable
              onPress={() => void toggle()}
              hitSlop={8}
              className="h-10 w-10 items-center justify-center"
              accessibilityRole="button"
              accessibilityLabel={
                isPlaying ? t('player.controls.pause') : t('player.controls.play')
              }
            >
              <Icon name={isPlaying ? 'pause' : 'play'} size={22} color={colors.primary} />
            </AnimatedPressable>
          </View>
        </View>
      </AnimatedPressable>
    </Animated.View>
  );
}
