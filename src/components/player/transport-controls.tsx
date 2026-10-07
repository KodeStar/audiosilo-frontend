import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { FOCUS_RING_CLASS } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { selectIsPlaying, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { useThemeColors } from '@/theme/use-theme-colors';

import { pillClass } from './control-pill';
import { SkipButton } from './skip-button';
import { stepSegment } from './transport';

export type TransportSize = 'lg' | 'md' | 'sm';

/** Dimensions per size: the full player (76 play / 54), a phone (70 / 48), the dock
 * (44 / 40, with hit slop to 44). */
const SIZES: Record<
  TransportSize,
  {
    play: number;
    button: number;
    playIcon: number;
    chapterIcon: number;
    skipFont: number;
    gap: number;
  }
> = {
  lg: { play: 76, button: 54, playIcon: 30, chapterIcon: 22, skipFont: 16, gap: 14 },
  md: { play: 70, button: 48, playIcon: 28, chapterIcon: 20, skipFont: 15, gap: 6 },
  sm: { play: 44, button: 40, playIcon: 18, chapterIcon: 16, skipFont: 13, gap: 6 },
};

/** Duration of the play/pause morph. */
const MORPH_MS = 140;

/** Play and pause crossfading and scaling (0.8 to 1) into each other. Reduced motion:
 * an instant swap. */
function PlayPauseGlyph({
  playing,
  size,
  color,
}: {
  playing: boolean;
  size: number;
  color: string;
}) {
  const reduced = useReducedMotion();
  const p = useSharedValue(playing ? 1 : 0);
  useEffect(() => {
    const to = playing ? 1 : 0;
    p.set(reduced ? to : withTiming(to, { duration: MORPH_MS, easing: Easing.out(Easing.ease) }));
  }, [playing, reduced, p]);
  const playStyle = useAnimatedStyle(() => ({
    opacity: 1 - p.get(),
    transform: [{ scale: 0.8 + 0.2 * (1 - p.get()) }],
  }));
  const pauseStyle = useAnimatedStyle(() => ({
    opacity: p.get(),
    transform: [{ scale: 0.8 + 0.2 * p.get() }],
  }));
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      {/* The play glyph sits a touch right of centre so it LOOKS centred. */}
      <Animated.View style={[{ position: 'absolute', left: size * 0.06 }, playStyle]}>
        <Icon name="play" size={size} color={color} />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute' }, pauseStyle]}>
        <Icon name="pause" size={size} color={color} />
      </Animated.View>
    </View>
  );
}

/**
 * The big play button: an ink circle (Stacks moves it from pink to ink), a spinner while
 * the book is loading, and Retry when playback failed (`error`). Bound to the player.
 * `plain` draws the glyph alone in the foreground colour, with no circle (the phone mini
 * player and the iOS accessory pill, STYLEGUIDE "Mini player"); it keeps a 44 pt target.
 */
export function PlayButton({
  size = 'md',
  plain = false,
}: {
  size?: TransportSize;
  plain?: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const state = usePlayer((s) => s.snapshot.state);
  const playing = usePlayer(selectIsPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const retry = usePlayer((s) => s.retry);
  const d = SIZES[size];
  const isError = state === 'error';
  const label = isError
    ? t('common.retry')
    : playing
      ? t('player.controls.pause')
      : t('player.controls.play');
  const color = plain ? themed.foreground : themed.primaryForeground;
  const box = plain ? d.button : d.play;
  return (
    <AnimatedPressable
      onPress={() => void (isError ? retry() : toggle())}
      hitSlop={Math.max(0, (44 - box) / 2)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: state === 'loading' }}
      className={
        plain
          ? pillClass('ghost')
          : cn(
              'items-center justify-center rounded-full bg-primary',
              size !== 'sm' && 'shadow-overlay',
              Platform.select({ web: cn('cursor-pointer', FOCUS_RING_CLASS) }),
            )
      }
      style={{ width: box, height: box }}
    >
      {state === 'loading' ? (
        <Spinner size={size === 'sm' ? 'small' : 'large'} color={color} />
      ) : isError ? (
        <Icon name="rotate" size={d.playIcon} color={color} />
      ) : (
        <PlayPauseGlyph
          playing={playing}
          size={plain ? d.playIcon + 4 : d.playIcon}
          color={color}
        />
      )}
    </AnimatedPressable>
  );
}

/**
 * The transport cluster (STYLEGUIDE section 8): previous chapter, back, play/pause,
 * forward, next chapter - bound to the player, at the full player's `lg` (76 play /
 * 54), a phone's `md` (70 / 48) or the dock's `sm` (44 / 40). Previous/next read the live
 * position at press time (`stepSegment`: chapters, else files); back/forward are the
 * listener's skip lengths. Renders nothing with no book loaded.
 */
export function TransportControls({
  size = 'md',
  className,
}: {
  size?: TransportSize;
  className?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const loaded = usePlayer((s) => s.nowPlaying !== null);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  if (!loaded) return null;

  const d = SIZES[size];
  const hitSlop = Math.max(0, (44 - d.button) / 2);
  const round = pillClass('ghost');
  const box = { width: d.button, height: d.button };
  const step = (dir: 1 | -1) => stepSegment(usePlayer.getState(), dir);

  return (
    <View className={cn('flex-row items-center justify-center', className)} style={{ gap: d.gap }}>
      <AnimatedPressable
        onPress={() => step(-1)}
        hitSlop={hitSlop}
        accessibilityRole="button"
        accessibilityLabel={t('player.controls.previous')}
        className={round}
        style={box}
      >
        <Icon name="prev" size={d.chapterIcon} color={themed.foreground} />
      </AnimatedPressable>
      <SkipButton
        direction="back"
        seconds={skipBackward}
        onPress={() => void skipSeconds(-skipBackward)}
        color={themed.foreground}
        fontSize={d.skipFont}
        hitSlop={hitSlop}
        className={round}
        style={box}
        accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
      />
      <PlayButton size={size} />
      <SkipButton
        direction="forward"
        seconds={skipForward}
        onPress={() => void skipSeconds(skipForward)}
        color={themed.foreground}
        fontSize={d.skipFont}
        hitSlop={hitSlop}
        className={round}
        style={box}
        accessibilityLabel={t('player.controls.skipForward', { seconds: skipForward })}
      />
      <AnimatedPressable
        onPress={() => step(1)}
        hitSlop={hitSlop}
        accessibilityRole="button"
        accessibilityLabel={t('player.controls.next')}
        className={round}
        style={box}
      >
        <Icon name="next" size={d.chapterIcon} color={themed.foreground} />
      </AnimatedPressable>
    </View>
  );
}
