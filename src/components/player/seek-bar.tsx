import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { useSliderControl } from '@/components/ui/use-slider-control';
import { formatClock, formatDuration, formatWallClock } from '@/lib/format';
import { useLatest } from '@/lib/use-latest';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import {
  selectBookKey,
  selectCurrentChapter,
  selectBookPosition,
  usePlayer,
} from '@/playback/store';
import { wallClockSeconds } from '@/playback/rate';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { barCountFor, barsPath, seekBars } from './seek-texture';
import { currentSegment } from './transport';
import { usePlayingPins } from './use-playing-pins';

/** The bars' band. */
const BAR_H = 44;
/** The strip above the bars that holds the bookmark glyphs. */
const PIN_H = 14;
/** The playhead: 4 wide, a little taller than the band, with a 3-point halo. */
const HEAD_W = 4;
const HEAD_H = 52;
const HALO = 3;

/** One layer of bars: a single SVG path, drawn once per layout (memo). */
const BarLayer = memo(function BarLayer({
  path,
  width,
  color,
  opacity = 1,
  testID,
}: {
  path: string;
  width: number;
  color: string;
  opacity?: number;
  testID: string;
}) {
  return (
    <Svg testID={testID} width={width} height={BAR_H} pointerEvents="none">
      <Path d={path} fill={color} fillOpacity={opacity} />
    </Svg>
  );
});

export type SeekBarProps = {
  /** Seconds into the segment (the chapter, or the file without a whole-book timeline). */
  position: number;
  /** The segment's length, seconds. */
  duration: number;
  /** Commits a position (seconds into the segment): a tap, a drag's release, a key. */
  onSeek: (position: number) => void;
  /** The position under the finger while dragging, then `null` on release. */
  onScrub?: (position: number | null) => void;
  /** Whether the scrub (or web hover) tip is showing: it floats over whatever sits just
   * above the bar, which the caller can make way for (the full player's status line). */
  onTip?: (showing: boolean) => void;
  /** Seeds the bar texture: one per book and chapter (`seekTextureKey`). */
  textureKey: string;
  /** Real audio peaks for the segment, any length and scale; replaces the texture. */
  peaks?: readonly number[];
  /** Bookmarks inside the segment, seconds into it: a glyph above each. */
  bookmarks?: readonly number[];
  /** Where the segment starts in the book: the scrub tip adds "17:26:50 in the book". */
  bookOffset?: number;
  /** Screen-reader increment/decrement and the web arrow keys: forward/back. Defaults
   * to moving by the skip lengths inside the segment. */
  onStep?: (direction: 1 | -1) => void;
  /** The accessible name ("Position in chapter"). */
  accessibilityLabel?: string;
  /** A fixed bar count; default, from the measured width (56 on a phone, 96 max). */
  bars?: number;
  disabled?: boolean;
  className?: string;
};

/**
 * The chapter-relative seek bar (STYLEGUIDE section 8, "Seek bar"): stylised bars, the
 * played ones in ink, the rest muted, the hovered ones (web) at 55% ink, a 4-point pink
 * playhead with a halo, bookmark glyphs above. Tap jumps; a drag scrubs with a tip
 * ("41:12 · 17:26:50 in the book") and commits on release.
 *
 * Cheap to re-render every playback tick: the bars are drawn ONCE per width as two
 * static SVG layers (unplayed, played); the played layer is revealed by a clip moved on
 * the UI thread (transforms only), so a tick changes two transforms, not 96 colours.
 *
 * Accessible as an `adjustable` slider: value text "41:12 of 1:17:48", increment and
 * decrement skip forward/back by the listener's skip lengths (the web arrow keys too).
 * Gesture and accessibility come from `useSliderControl`, shared with `Slider`.
 */
export function SeekBar({
  position,
  duration,
  onSeek,
  onScrub,
  onTip,
  textureKey,
  peaks,
  bookmarks,
  bookOffset,
  onStep,
  accessibilityLabel,
  bars,
  disabled = false,
  className,
}: SeekBarProps) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const length = Math.max(0, duration);
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const {
    gesture,
    width: widthSv,
    dragging,
    dragFrac,
    posFrac,
    controlProps,
  } = useSliderControl({
    value: Math.max(0, Math.min(length, position)),
    max: length,
    step: skipForward,
    onStep:
      onStep ??
      ((dir) =>
        onSeek(
          Math.max(0, Math.min(length, position + (dir === 1 ? skipForward : -skipBackward))),
        )),
    onValueCommit: onSeek,
    onPreview: (v) => {
      setScrub(v);
      onScrub?.(v);
    },
    accessibilityLabel: accessibilityLabel ?? t('player.seek.label'),
    valueText: (v) =>
      t('player.seek.value', { position: formatClock(v), duration: formatClock(length) }),
    disabled,
  });

  const count = bars ?? barCountFor(width);
  const heights = useMemo(() => seekBars(textureKey, count, peaks), [textureKey, count, peaks]);
  const path = useMemo(() => barsPath(heights, width, BAR_H), [heights, width]);

  // The played layer: a clip that slides in from the left, its content slid back by the
  // same amount so the bars stay put. The playhead rides its edge.
  const clipStyle = useAnimatedStyle(() => {
    const f = dragging.get() ? dragFrac.get() : posFrac.get();
    return { transform: [{ translateX: -(1 - f) * widthSv.get() }] };
  });
  const contentStyle = useAnimatedStyle(() => {
    const f = dragging.get() ? dragFrac.get() : posFrac.get();
    return { transform: [{ translateX: (1 - f) * widthSv.get() }] };
  });
  const headStyle = useAnimatedStyle(() => {
    const f = dragging.get() ? dragFrac.get() : posFrac.get();
    return { transform: [{ translateX: f * widthSv.get() - HEAD_W / 2 - HALO }] };
  });

  const onLayout = (e: LayoutChangeEvent) => {
    controlProps.onLayout(e);
    setWidth(e.nativeEvent.layout.width);
  };

  // Web hover: where the pointer is, for the 55% bars and the "click to jump" tip.
  const hoverProps =
    Platform.OS === 'web' && !disabled
      ? {
          onPointerMove: (e: { nativeEvent: { clientX: number }; currentTarget: unknown }) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect?.();
            if (!rect || rect.width <= 0) return;
            setHover(Math.max(0, Math.min(1, (e.nativeEvent.clientX - rect.left) / rect.width)));
          },
          onPointerLeave: () => setHover(null),
        }
      : {};

  const tipFrac = scrub !== null && length > 0 ? scrub / length : hover;
  const tipSeconds = scrub ?? (hover !== null ? hover * length : null);
  const tipShowing = tipFrac !== null && tipSeconds !== null && width > 0;
  const reportTip = useLatest((showing: boolean) => onTip?.(showing));
  useEffect(() => {
    reportTip(tipShowing);
  }, [tipShowing, reportTip]);

  return (
    <GestureDetector gesture={gesture}>
      <View
        {...controlProps}
        {...hoverProps}
        onLayout={onLayout}
        style={{ height: PIN_H + BAR_H }}
        className={cn(
          Platform.select({ web: `cursor-pointer rounded-md ${FOCUS_RING_CLASS}` }),
          disabled && 'opacity-50',
          className,
        )}
      >
        {/* Bookmark glyphs above their bars. */}
        {length > 0 && width > 0
          ? (bookmarks ?? [])
              .filter((b) => b >= 0 && b <= length)
              .map((b, i) => (
                <View
                  key={`${b}-${i}`}
                  testID="seek-bookmark"
                  pointerEvents="none"
                  style={{ position: 'absolute', top: 0, left: (b / length) * width - 6 }}
                >
                  <Icon name="bookmark" size={12} color={themed.foreground} />
                </View>
              ))
          : null}

        <View style={{ position: 'absolute', top: PIN_H, left: 0, right: 0, height: BAR_H }}>
          {width > 0 && path ? (
            <>
              <BarLayer
                testID="seek-bars"
                path={path}
                width={width}
                color={themed.mutedForeground}
                opacity={0.28}
              />
              {hover !== null ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: hover * width,
                    height: BAR_H,
                    overflow: 'hidden',
                  }}
                >
                  <BarLayer
                    testID="seek-bars-hovered"
                    path={path}
                    width={width}
                    color={themed.foreground}
                    opacity={0.55}
                  />
                </View>
              ) : null}
              <Animated.View
                pointerEvents="none"
                style={[
                  {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width,
                    height: BAR_H,
                    overflow: 'hidden',
                  },
                  clipStyle,
                ]}
              >
                <Animated.View style={contentStyle}>
                  <BarLayer
                    testID="seek-bars-played"
                    path={path}
                    width={width}
                    color={themed.foreground}
                  />
                </Animated.View>
              </Animated.View>
            </>
          ) : null}

          {/* The playhead with its halo. */}
          <Animated.View
            pointerEvents="none"
            className="items-center justify-center rounded-full bg-brand/25"
            style={[
              {
                position: 'absolute',
                left: 0,
                top: (BAR_H - HEAD_H) / 2 - HALO,
                width: HEAD_W + HALO * 2,
                height: HEAD_H + HALO * 2,
              },
              headStyle,
            ]}
          >
            <View className="rounded-full bg-brand" style={{ width: HEAD_W, height: HEAD_H }} />
          </Animated.View>
        </View>

        {/* The scrub (or, on the web, hover) tip. */}
        {tipShowing ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              bottom: PIN_H + BAR_H + 4,
              left: Math.max(48, Math.min(width - 48, tipFrac * width)),
              width: 0,
              alignItems: 'center',
            }}
          >
            <View className="items-center rounded-control bg-primary px-2.5 py-1.5 shadow-overlay">
              <Text
                className="font-sans-semibold text-xs text-primary-foreground"
                style={tabularNums}
                numberOfLines={1}
              >
                {formatClock(tipSeconds)}
              </Text>
              <Text
                className="font-sans text-[11px] text-primary-foreground/70"
                style={tabularNums}
                numberOfLines={1}
              >
                {scrub !== null && bookOffset !== undefined
                  ? t('player.seek.inBook', { time: formatClock(bookOffset + scrub) })
                  : scrub === null
                    ? t('player.seek.clickToJump')
                    : ''}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

/** The texture key for a segment of a book: one look per book and chapter. */
export function seekTextureKey(bookKey: string | null, segmentStart: number): string {
  return `${bookKey ?? ''}#${Math.round(segmentStart)}`;
}

/**
 * The times row under the seek bar: elapsed, "21m left in the chapter · ends 22:01"
 * (wall-clock time at the current speed, the end on the local clock) and "-remaining".
 * Presentational; `PlayerSeekBar` feeds it.
 */
export function SeekTimes({
  elapsed,
  length,
  rate,
  perFile = false,
  className,
}: {
  elapsed: number;
  length: number;
  rate: number;
  /** The segment is a file (no whole-book timeline), not a chapter. */
  perFile?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const now = useNow(15_000);
  const remaining = Math.max(0, length - elapsed);
  const wall = wallClockSeconds(remaining, rate);
  const time = formatDuration(wall);
  const clock = formatWallClock(new Date(now + wall * 1000));
  return (
    <View className={cn('flex-row items-center justify-between gap-2', className)}>
      <Text variant="caption" style={tabularNums}>
        {formatClock(elapsed)}
      </Text>
      <Text
        variant="caption"
        className="flex-1 text-center font-sans-semibold text-foreground"
        style={tabularNums}
        numberOfLines={1}
      >
        {time
          ? t(perFile ? 'player.seek.fileLeft' : 'player.seek.chapterLeft', { time, clock })
          : ''}
      </Text>
      <Text variant="caption" style={tabularNums}>
        -{formatClock(remaining)}
      </Text>
    </View>
  );
}

/**
 * The seek bar bound to the player: the current chapter (or file, for a book without a
 * whole-book timeline), its bookmarks, seeking and skipping through the store, and with
 * `times` the times row under it. Re-renders on every tick by design (see `SeekBar`).
 * `onScrub` reports the scrub preview (seconds into the segment) for a caller whose own
 * labels should follow it.
 */
export function PlayerSeekBar({
  times = false,
  onScrub,
  onTip,
  bars,
  className,
}: {
  times?: boolean;
  onScrub?: (position: number | null) => void;
  onTip?: (showing: boolean) => void;
  bars?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const total = usePlayer((s) => s.nowPlaying?.queue.total ?? 0);
  const bookKey = usePlayer(selectBookKey);
  const chapter = usePlayer(selectCurrentChapter);
  const trackIndex = usePlayer((s) => s.snapshot.trackIndex);
  const trackDuration = usePlayer((s) => s.snapshot.duration);
  const elapsedLive = usePlayer(
    (s) =>
      currentSegment({
        total,
        bookPosition: selectBookPosition(s),
        chapter: selectCurrentChapter(s),
        trackPosition: s.snapshot.position,
        trackDuration: s.snapshot.duration,
      }).elapsed,
  );
  const rate = usePlayer((s) => s.rate);
  const seekBook = usePlayer((s) => s.seekBook);
  const seekInTrack = usePlayer((s) => s.seekInTrack);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const pins = usePlayingPins();
  const [scrub, setScrub] = useState<number | null>(null);

  const segment = currentSegment({
    total,
    bookPosition: 0,
    chapter,
    trackPosition: 0,
    trackDuration,
  });
  const inSegment = useMemo(
    () =>
      segment.perTrack
        ? []
        : pins.bookmarks
            .filter((p) => p >= segment.start && p < segment.start + segment.length)
            .map((p) => p - segment.start),
    [pins.bookmarks, segment.perTrack, segment.start, segment.length],
  );
  if (!bookKey) return null;

  const onSeek = (p: number) =>
    segment.perTrack ? void seekInTrack(p) : void seekBook(segment.start + p);
  return (
    <View className={cn('gap-1', className)}>
      <SeekBar
        position={elapsedLive}
        duration={segment.length}
        onSeek={onSeek}
        onScrub={(v) => {
          setScrub(v);
          onScrub?.(v);
        }}
        onTip={onTip}
        textureKey={seekTextureKey(bookKey, segment.perTrack ? -1 - trackIndex : segment.start)}
        bookmarks={inSegment}
        bookOffset={segment.perTrack ? undefined : segment.start}
        onStep={(dir) => void skipSeconds(dir === 1 ? skipForward : -skipBackward)}
        accessibilityLabel={segment.perTrack ? t('player.seek.labelFile') : undefined}
        bars={bars}
      />
      {times ? (
        <SeekTimes
          elapsed={scrub ?? elapsedLive}
          length={segment.length}
          rate={rate}
          perFile={segment.perTrack}
        />
      ) : null}
    </View>
  );
}
