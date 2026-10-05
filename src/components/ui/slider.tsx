import { useMemo } from 'react';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

const TRACK_H = 6; // slim visual track
const HIT_H = 44; // the touch target (STYLEGUIDE.md section 14)
const THUMB = 16; // resting thumb diameter

function clampFrac(v: number): number {
  'worklet';
  return Math.max(0, Math.min(1, v));
}

export type SliderProps = {
  value: number;
  min?: number;
  max: number;
  /** Keyboard (web) and screen-reader increment/decrement step, in value units. */
  step: number;
  /** Commits a value: a tap, the end of a drag, an arrow key, a screen-reader swipe. */
  onValueCommit: (value: number) => void;
  /** The value under the thumb while dragging, then `null` when the drag ends - lets a
   * consumer make its labels follow the scrub before anything is committed. */
  onPreview?: (value: number | null) => void;
  /** The accessible name ("Playback position"). */
  accessibilityLabel: string;
  /** What a screen reader reads for the value (`aria-valuetext`): "41:12 of 1:17:48". */
  valueText?: (value: number) => string;
  /** `ink` (default) is the Stacks slider fill; `brand` is for progress (the seek bar). */
  tone?: 'ink' | 'brand';
  disabled?: boolean;
  className?: string;
};

/**
 * The Stacks slider (STYLEGUIDE.md section 8, hand-built on primitives): a 6px track,
 * an ink (or `brand` for progress) fill and a white thumb, inside a 44pt hit area.
 *
 * Tap jumps; a drag scrubs (the thumb grows while held) and commits on release. It is an
 * `adjustable` element (`role="slider"` on web) with a value text, increment/decrement
 * accessibility actions, and on web the arrow keys (one `step`), Page Up/Down (ten) and
 * Home/End. Gesture-handler + reanimated move the thumb and fill on the UI thread.
 */
export function Slider({
  value,
  min = 0,
  max,
  step,
  onValueCommit,
  onPreview,
  accessibilityLabel,
  valueText,
  tone = 'ink',
  disabled = false,
  className,
}: SliderProps) {
  const themed = useThemeColors();
  const width = useSharedValue(0);
  const dragging = useSharedValue(0);
  const dragFrac = useSharedValue(0);
  const posFrac = useSharedValue(0);

  const span = max - min;
  // Track the live value from props on the UI thread (read inside worklets).
  posFrac.value = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0;

  const gesture = useMemo(() => {
    const preview = (v: number | null) => onPreview?.(v);
    const commit = (f: number) => onValueCommit(min + f * (span > 0 ? span : 0));
    const fracAt = (x: number) => {
      'worklet';
      return clampFrac(width.value > 0 ? x / width.value : 0);
    };

    const pan = Gesture.Pan()
      .enabled(!disabled)
      .onBegin((e) => {
        dragging.value = 1;
        dragFrac.value = fracAt(e.x);
        if (span > 0) runOnJS(preview)(min + dragFrac.value * span);
      })
      .onUpdate((e) => {
        dragFrac.value = fracAt(e.x);
        if (span > 0) runOnJS(preview)(min + dragFrac.value * span);
      })
      .onEnd((e) => {
        const f = fracAt(e.x);
        posFrac.value = f; // hold the thumb at release, no snap-back before the prop catches up
        runOnJS(commit)(f);
      })
      .onFinalize(() => {
        dragging.value = 0;
        runOnJS(preview)(null);
      });

    // Gesture-handler's default tap window (500ms), not a tight cap: a deliberate,
    // slightly slow press-and-release with no drag must still jump. A too-short cap on a
    // motionless press activates neither Tap nor Pan, and the tap silently no-ops.
    const tap = Gesture.Tap()
      .enabled(!disabled)
      .onEnd((e) => {
        const f = fracAt(e.x);
        posFrac.value = f;
        runOnJS(commit)(f);
      });

    return Gesture.Race(pan, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shared values are stable refs
  }, [min, span, disabled, onValueCommit, onPreview]);

  const fillStyle = useAnimatedStyle(() => {
    const f = dragging.value ? dragFrac.value : posFrac.value;
    return { transform: [{ translateX: -(1 - f) * width.value }] };
  });

  const thumbStyle = useAnimatedStyle(() => {
    const f = dragging.value ? dragFrac.value : posFrac.value;
    return {
      transform: [{ translateX: f * width.value - THUMB / 2 }, { scale: 1 + dragging.value * 0.4 }],
    };
  });

  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
  };

  const stepBy = (delta: number) => {
    if (disabled || span <= 0) return;
    onValueCommit(Math.max(min, Math.min(max, value + delta)));
  };

  // Web keyboard. React Native's View types don't declare onKeyDown; react-native-web
  // forwards it to the DOM node.
  const keyboard =
    Platform.OS === 'web'
      ? {
          focusable: !disabled,
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            const moves: Record<string, number> = {
              ArrowRight: step,
              ArrowUp: step,
              ArrowLeft: -step,
              ArrowDown: -step,
              PageUp: step * 10,
              PageDown: -step * 10,
              Home: min - value,
              End: max - value,
            };
            const delta = moves[e.key];
            if (delta === undefined) return;
            e.preventDefault();
            stepBy(delta);
          },
        }
      : {};

  const fill = tone === 'brand' ? themed.brand : themed.primary;

  return (
    <GestureDetector gesture={gesture}>
      <View
        onLayout={onLayout}
        style={{ height: HIT_H }}
        className={cn(
          'justify-center',
          Platform.select({
            web: 'cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
          }),
          disabled && 'opacity-50',
          className,
        )}
        // One accessibility element (a View isn't one by default): VoiceOver/TalkBack
        // focus it and swipe up/down to adjust.
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        // The aria-value* props, not `accessibilityValue`: react-native maps both on
        // native, but react-native-web reads only these (the old seek bar's object form
        // never reached the DOM, so the web slider had no value).
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.max(Math.round(min), Math.round(max))}
        aria-valuenow={Math.round(Math.max(min, Math.min(max, value)))}
        aria-valuetext={valueText?.(value)}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'increment') stepBy(step);
          else if (e.nativeEvent.actionName === 'decrement') stepBy(-step);
        }}
        {...keyboard}
      >
        <View style={{ height: TRACK_H }} className="overflow-hidden rounded-full bg-foreground/15">
          <Animated.View
            style={[
              { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, borderRadius: 999 },
              { backgroundColor: fill },
              fillStyle,
            ]}
          />
        </View>
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: 0,
              top: '50%',
              marginTop: -THUMB / 2,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: themed.borderStrong,
              boxShadow: '0px 1px 3px rgba(14, 22, 48, 0.25)',
            },
            thumbStyle,
          ]}
        />
      </View>
    </GestureDetector>
  );
}
