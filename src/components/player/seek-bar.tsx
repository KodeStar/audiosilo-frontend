import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { useSliderControl } from '@/components/ui/use-slider-control';
import { formatClock, formatDuration, formatWallClock } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { selectBookKey, usePlayer } from '@/playback/store';
import { timeLeft } from '@/playback/time-left';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { headFraction, Playhead, ScrubTip, useWebHoverFraction } from './scrub-parts';
import { barCountFor, barsPath, seekBars } from './seek-texture';
import { SEGMENT_LABEL, type SegmentKind, usePlayingSegment } from './use-playing-segment';

/** The bars' band. */
const BAR_H = 44;
/** The strip above the bars that holds the bookmark glyphs. */
const PIN_H = 14;
/** The playhead: 4 wide, a little taller than the band. */
const HEAD_W = 4;
const HEAD_H = 52;

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
  /** Whether the scrub (or web hover) tip is showing (`ScrubTip`): it floats over
   * whatever sits just above the bar, which the caller can make way for (the full
   * player's status line). */
  onTip?: (showing: boolean) => void;
  /** Whether a web hover shows the tip (default on): the hovered bars shade either way,
   * and a drag's tip always shows. */
  hoverTip?: boolean;
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
  hoverTip = true,
  textureKey,
  peaks,
  bookmarks,
  bookOffset,
  onStep,
  accessibilityLabel,
  bars,
  className,
}: SeekBarProps) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const length = Math.max(0, duration);
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const { hover, hoverProps } = useWebHoverFraction(true);

  const control = useSliderControl({
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
  });
  const { gesture, controlProps, track } = control;

  const count = bars ?? barCountFor(width);
  const heights = useMemo(() => seekBars(textureKey, count, peaks), [textureKey, count, peaks]);
  const path = useMemo(() => barsPath(heights, width, BAR_H), [heights, width]);

  // The played layer: a clip that slides in from the left, its content slid back by the
  // same amount so the bars stay put. The playhead rides its edge.
  const clipStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -(1 - headFraction(track)) * track.width.get() }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - headFraction(track)) * track.width.get() }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    controlProps.onLayout(e);
    setWidth(e.nativeEvent.layout.width);
  };

  const hoverAt = hoverTip ? hover : null;
  const tipSeconds = scrub ?? (hoverAt !== null ? hoverAt * length : null);
  const tipFrac = scrub !== null ? (length > 0 ? scrub / length : null) : hoverAt;

  return (
    // pan-y: on the web a touch that starts on the bar can still scroll the player.
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <View
        {...controlProps}
        {...hoverProps}
        onLayout={onLayout}
        style={{ height: PIN_H + BAR_H }}
        className={cn(
          Platform.select({ web: `cursor-pointer rounded-md ${FOCUS_RING_CLASS}` }),
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

          <Playhead track={track} width={HEAD_W} height={HEAD_H} top={(BAR_H - HEAD_H) / 2} />
        </View>

        {/* The scrub (or, on the web, hover) tip. */}
        {tipFrac !== null && tipSeconds !== null && width > 0 ? (
          <ScrubTip
            x={tipFrac * width}
            width={width}
            edge={48}
            bottom={PIN_H + BAR_H + 4}
            onTip={onTip}
          >
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
          </ScrubTip>
        ) : null}
      </View>
    </GestureDetector>
  );
}

/** The texture key for a segment of a book: one look per book and chapter. */
export function seekTextureKey(bookKey: string | null, segmentStart: number): string {
  return `${bookKey ?? ''}#${Math.round(segmentStart)}`;
}

/** The times row's "21m left in the chapter · ends 22:01", by segment (i18n keys). */
const SEGMENT_LEFT = {
  chapter: 'player.seek.chapterLeft',
  book: 'player.seek.bookLeft',
  file: 'player.seek.fileLeft',
} as const satisfies Record<SegmentKind, string>;

/**
 * The times row under the seek bar: elapsed, "21m left in the chapter · ends 22:01"
 * (wall-clock time at the current speed, the end on the local clock) and "-remaining".
 * Presentational and memoised: `PlayerSeekBar` feeds it whole seconds, so it redraws
 * once a second, not per engine tick.
 */
export const SeekTimes = memo(function SeekTimes({
  elapsed,
  length,
  rate,
  kind = 'chapter',
  className,
}: {
  elapsed: number;
  length: number;
  rate: number;
  /** What the segment is: "left in the chapter", "in the book" or "in the file". */
  kind?: SegmentKind;
  className?: string;
}) {
  const { t } = useTranslation();
  const now = useNow(15_000);
  const remaining = Math.max(0, length - elapsed);
  // Time left to the segment's end at the speed: the app's one speed rule.
  const wall = timeLeft(elapsed, length, rate)?.seconds ?? 0;
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
        {time ? t(SEGMENT_LEFT[kind], { time, clock }) : ''}
      </Text>
      <Text variant="caption" style={tabularNums}>
        -{formatClock(remaining)}
      </Text>
    </View>
  );
});

/**
 * The seek bar bound to the player, with the times row under it: the current chapter (or
 * file, for a book without a whole-book timeline), its bookmarks (`bookmarks`, the
 * playing book's, whole-book seconds: the caller's one `usePlayingPins`), seeking and
 * skipping through the store. The bar re-renders on every tick by design (see
 * `SeekBar`); the times row follows the scrub. `timesHidden` lets the times row make
 * way for the whole-book timeline's tip, which floats over it.
 */
export function PlayerSeekBar({
  bookmarks,
  onTip,
  hoverTip,
  timesHidden = false,
  bars,
}: {
  bookmarks?: readonly number[];
  onTip?: (showing: boolean) => void;
  hoverTip?: boolean;
  timesHidden?: boolean;
  bars?: number;
}) {
  const { t } = useTranslation();
  const bookKey = usePlayer(selectBookKey);
  const trackIndex = usePlayer((s) => s.snapshot.trackIndex);
  const rate = usePlayer((s) => s.rate);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const [scrub, setScrub] = useState<number | null>(null);
  const {
    segment,
    kind,
    elapsed,
    onSeek,
    bookmarks: inSegment,
  } = usePlayingSegment(bookmarks, { hold: scrub !== null });
  if (!bookKey) return null;

  return (
    <View className="gap-1">
      <SeekBar
        position={elapsed}
        duration={segment.length}
        onSeek={onSeek}
        onScrub={setScrub}
        onTip={onTip}
        hoverTip={hoverTip}
        textureKey={seekTextureKey(bookKey, segment.perTrack ? -1 - trackIndex : segment.start)}
        bookmarks={inSegment}
        bookOffset={segment.perTrack ? undefined : segment.start}
        onStep={(dir) => void skipSeconds(dir === 1 ? skipForward : -skipBackward)}
        accessibilityLabel={t(SEGMENT_LABEL[kind])}
        bars={bars}
      />
      <View
        style={timesHidden ? { opacity: 0 } : undefined}
        aria-hidden={timesHidden || undefined}
        importantForAccessibility={timesHidden ? 'no-hide-descendants' : 'auto'}
      >
        <SeekTimes
          elapsed={Math.floor(scrub ?? elapsed)}
          length={segment.length}
          rate={rate}
          kind={kind}
        />
      </View>
    </View>
  );
}
