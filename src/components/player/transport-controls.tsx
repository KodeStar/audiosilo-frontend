import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Platform, View } from 'react-native';
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
import { useFontScale } from '@/lib/text-scale';
import { cn } from '@/lib/utils';
import { onForeground } from '@/lib/when-active';
import { selectIsPlaying, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { useThemeColors } from '@/theme/use-theme-colors';

import { pillClass } from './control-pill';
import { SkipButton } from './skip-button';
import { stepSegment } from './transport';

export type TransportSize = 'lg' | 'md' | 'sm';

type TransportDims = {
  play: number;
  button: number;
  playIcon: number;
  chapterIcon: number;
  skipFont: number;
  gap: number;
};

/** Dimensions per size: the full player (76 play / 54), a phone (70 / 48), the dock
 * (44 / 40, with hit slop to 44). */
const SIZES: Record<TransportSize, TransportDims> = {
  lg: { play: 76, button: 54, playIcon: 30, chapterIcon: 22, skipFont: 16, gap: 14 },
  md: { play: 70, button: 48, playIcon: 28, chapterIcon: 20, skipFont: 15, gap: 6 },
  sm: { play: 44, button: 40, playIcon: 18, chapterIcon: 16, skipFont: 13, gap: 6 },
};

/** The transport's width at a size: four buttons and the play button, a gap between each
 * (for a column that lays out around it, like the dock's middle one). */
export function transportWidth(size: TransportSize): number {
  return widthOf(SIZES[size]);
}

function widthOf(d: TransportDims): number {
  return 4 * d.button + d.play + 4 * d.gap;
}

/** The most the full player's controls grow with the text (fe#267, owner decision 3). */
export const CONTROL_MAX_SCALE = 1.5;
/** The least they shrink to fit a narrow column (a 320 wide phone at the largest display
 * size): a 48 button is still past the 44 target at this. */
const CONTROL_MIN_SCALE = 0.9;

/**
 * The full player's control scale: the text scale (never under 1), capped at
 * `CONTROL_MAX_SCALE` and at what fits `room` (the column's width; 0 = not measured yet,
 * no fit). A column narrower than the transport at 1 shrinks it to fit, down to
 * `CONTROL_MIN_SCALE`, rather than run it past the edges.
 */
export function controlScale(size: TransportSize, fontScale: number, room = 0): number {
  const wanted = Math.min(Math.max(1, fontScale), CONTROL_MAX_SCALE);
  if (room <= 0) return wanted;
  // The gaps keep their size (`transportDims`): only the buttons scale.
  const d = SIZES[size];
  const fit = (room - 4 * d.gap) / (4 * d.button + d.play);
  return Math.max(CONTROL_MIN_SCALE, Math.min(wanted, fit));
}

/** A size's dimensions at a control scale (`controlScale`). */
export function transportDims(size: TransportSize, scale = 1): TransportDims {
  const d = SIZES[size];
  if (scale === 1) return d;
  const at = (n: number) => Math.round(n * scale);
  // The boxes round down, so a fitted transport never passes its room.
  const box = (n: number) => Math.floor(n * scale);
  return {
    play: box(d.play),
    button: box(d.button),
    playIcon: at(d.playIcon),
    chapterIcon: at(d.chapterIcon),
    skipFont: at(d.skipFont),
    // The gaps stay: the room goes to the buttons.
    gap: d.gap,
  };
}

/** The transport's width at a control scale (for a test, or a layout around it). */
export function scaledTransportWidth(size: TransportSize, scale: number): number {
  return widthOf(transportDims(size, scale));
}

/** Duration of the play/pause morph. */
const MORPH_MS = 140;

/** Bumped each time the app comes back to the foreground (see `PlayPauseGlyph`). */
function useForegroundTurn(): number {
  const [turn, setTurn] = useState(0);
  useEffect(() => onForeground(() => setTurn((n) => n + 1)), []);
  return turn;
}

/**
 * Play and pause crossfading and scaling (0.8 to 1) into each other. Reduced motion:
 * an instant swap.
 *
 * Away from the foreground it swaps instantly too, and its host remounts it on the way
 * back (`useForegroundTurn` as its key): on the Pixel a book paused from the shade, then
 * moved by a pick-up, left the floating mini player drawing Pause for 20+ s while the
 * store, the full player and the media session all said paused (remounting it, by
 * opening the full player, put it right). The morph's props are applied outside React's
 * tree by frames that do not run while the app is away, so a morph started then can be
 * lost, and nothing redraws a settled glyph; a fresh one starts from `playing`.
 */
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
    const instant = reduced || AppState.currentState !== 'active';
    p.set(instant ? to : withTiming(to, { duration: MORPH_MS, easing: Easing.out(Easing.ease) }));
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
    <View
      testID="play-pause-glyph"
      style={{ width: size, height: size }}
      className="items-center justify-center"
    >
      {/* The play glyph sits a touch right of centre so it LOOKS centred. */}
      <Animated.View
        testID="play-glyph"
        style={[{ position: 'absolute', left: size * 0.06 }, playStyle]}
      >
        <Icon name="play" size={size} color={color} />
      </Animated.View>
      <Animated.View testID="pause-glyph" style={[{ position: 'absolute' }, pauseStyle]}>
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
  scale = 1,
}: {
  size?: TransportSize;
  plain?: boolean;
  /** The control scale (`controlScale`), the full player's transport only. */
  scale?: number;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const state = usePlayer((s) => s.snapshot.state);
  const playing = usePlayer(selectIsPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const retry = usePlayer((s) => s.retry);
  const turn = useForegroundTurn();
  const d = transportDims(size, scale);
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
          key={turn}
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
 *
 * The full player's sizes grow with the text size (`controlScale`, capped, and fitted to
 * `room`, the column's width); the dock's `sm` keeps its size (its bar lays out around
 * `transportWidth('sm')`).
 */
export function TransportControls({
  size = 'md',
  room,
  className,
}: {
  size?: TransportSize;
  /** The width the transport may take (the full player's column), to fit it. */
  room?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const fontScale = useFontScale();
  const loaded = usePlayer((s) => s.nowPlaying !== null);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  if (!loaded) return null;

  const scale = size === 'sm' ? 1 : controlScale(size, fontScale, room);
  const d = transportDims(size, scale);
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
        maxFontScale={1}
        hitSlop={hitSlop}
        className={round}
        style={box}
        accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
      />
      <PlayButton size={size} scale={scale} />
      <SkipButton
        direction="forward"
        seconds={skipForward}
        onPress={() => void skipSeconds(skipForward)}
        color={themed.foreground}
        fontSize={d.skipFont}
        maxFontScale={1}
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
