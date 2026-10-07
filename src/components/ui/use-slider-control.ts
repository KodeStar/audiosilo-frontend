import { useEffect, useMemo } from 'react';
import { type LayoutChangeEvent, Platform } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';

import { useLatest } from '@/lib/use-latest';

function clampFrac(v: number): number {
  'worklet';
  return Math.max(0, Math.min(1, v));
}

export type SliderControlOptions = {
  value: number;
  min?: number;
  max: number;
  /** Keyboard (web) and screen-reader increment/decrement step, in value units. */
  step: number;
  /** Replaces the one-`step` move of the arrow keys and the screen-reader actions (the
   * seek bar skips by the listener's skip lengths, which differ back and forward). Page
   * Up/Down and Home/End still move by value. */
  onStep?: (direction: 1 | -1) => void;
  /** Commits a value: a tap, the end of a drag, a key, a screen-reader swipe. */
  onValueCommit: (value: number) => void;
  /** The value under the finger while dragging, then `null` when the drag ends. */
  onPreview?: (value: number | null) => void;
  /** Moves a TAP's value before it commits (the timeline's pins: a tap on one lands on
   * it exactly). Drags and keys commit as they are. */
  snapTap?: (value: number) => number;
  /** The accessible name. */
  accessibilityLabel: string;
  /** What a screen reader reads for the value (`aria-valuetext`). */
  valueText?: (value: number) => string;
  disabled?: boolean;
};

/**
 * The behaviour of a horizontal slider, shared by the `Slider` primitive, the seek bar
 * and the whole-book timeline, so the fixes live once:
 *
 * - Gesture-handler + reanimated: a tap jumps, a drag scrubs (previewed through
 *   `onPreview` on the JS thread) and commits on release. The gesture is built from
 *   stable stand-ins for the callbacks (`useLatest`), so a consumer that re-renders
 *   every playback tick does not reattach the handlers mid-drag.
 * - The live value reaches the UI thread in an EFFECT (`posFrac`), never during render
 *   (Reanimated warns about a shared-value write while rendering).
 * - One accessibility element: `adjustable` with min/max/now/value text through the
 *   `aria-value*` props (react-native-web reads only those) and increment/decrement
 *   actions; on web it is focusable and takes the arrow keys, Page Up/Down (ten steps)
 *   and Home/End.
 *
 * The caller draws: `posFrac` is where the value is (0..1), `dragFrac` where the finger
 * is while `dragging` is 1, `width` the measured track width (set by `onLayout`); `track`
 * is the four together, one stable object for a worklet to read (the player's
 * `Playhead`). Spread `controlProps` on the View that `<GestureDetector gesture={gesture}>`
 * wraps.
 */
export function useSliderControl({
  value,
  min = 0,
  max,
  step,
  onStep,
  onValueCommit,
  onPreview,
  snapTap,
  accessibilityLabel,
  valueText,
  disabled = false,
}: SliderControlOptions) {
  const span = max - min;
  const frac = span > 0 ? clampFrac((value - min) / span) : 0;
  const width = useSharedValue(0);
  const dragging = useSharedValue(0);
  const dragFrac = useSharedValue(0);
  const posFrac = useSharedValue(frac);

  // `set()` rather than `.value =`: the React Compiler-safe form.
  useEffect(() => {
    posFrac.set(frac);
  }, [frac, posFrac]);

  const commitValue = useLatest(onValueCommit);
  const previewValue = useLatest((v: number | null) => onPreview?.(v));
  const snapValue = useLatest((v: number) => (snapTap ? snapTap(v) : v));

  const gesture = useMemo(() => {
    const valueAt = (f: number) => min + f * (span > 0 ? span : 0);
    const commit = (f: number) => commitValue(valueAt(f));
    const commitTap = (f: number) => commitValue(snapValue(valueAt(f)));
    const fracAt = (x: number) => {
      'worklet';
      return clampFrac(width.get() > 0 ? x / width.get() : 0);
    };

    const pan = Gesture.Pan()
      .enabled(!disabled)
      .onBegin((e) => {
        dragging.set(1);
        dragFrac.set(fracAt(e.x));
        if (span > 0) runOnJS(previewValue)(min + dragFrac.get() * span);
      })
      .onUpdate((e) => {
        dragFrac.set(fracAt(e.x));
        if (span > 0) runOnJS(previewValue)(min + dragFrac.get() * span);
      })
      .onEnd((e) => {
        const f = fracAt(e.x);
        posFrac.set(f); // hold at release, no snap-back before the prop catches up
        runOnJS(commit)(f);
      })
      .onFinalize(() => {
        dragging.set(0);
        runOnJS(previewValue)(null);
      });

    // Gesture-handler's default tap window (500ms), not a tight cap: a deliberate,
    // slightly slow press-and-release with no drag must still jump. A too-short cap on a
    // motionless press activates neither Tap nor Pan, and the tap silently no-ops.
    const tap = Gesture.Tap()
      .enabled(!disabled)
      .onEnd((e) => {
        const f = fracAt(e.x);
        posFrac.set(f);
        runOnJS(commitTap)(f);
      });

    return Gesture.Race(pan, tap);
  }, [
    min,
    span,
    disabled,
    width,
    dragging,
    dragFrac,
    posFrac,
    commitValue,
    previewValue,
    snapValue,
  ]);

  const onLayout = (e: LayoutChangeEvent) => {
    width.set(e.nativeEvent.layout.width);
  };

  const moveBy = (delta: number) => {
    if (disabled || span <= 0) return;
    onValueCommit(Math.max(min, Math.min(max, value + delta)));
  };
  const stepOnce = (direction: 1 | -1) => {
    if (disabled || span <= 0) return;
    if (onStep) onStep(direction);
    else moveBy(direction * step);
  };

  // Web keyboard. React Native's View types don't declare onKeyDown; react-native-web
  // forwards it to the DOM node.
  const keyboard =
    Platform.OS === 'web'
      ? {
          focusable: !disabled,
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            const steps: Record<string, 1 | -1> = {
              ArrowRight: 1,
              ArrowUp: 1,
              ArrowLeft: -1,
              ArrowDown: -1,
            };
            const moves: Record<string, number> = {
              PageUp: step * 10,
              PageDown: -step * 10,
              Home: min - value,
              End: max - value,
            };
            if (steps[e.key] !== undefined) {
              e.preventDefault();
              stepOnce(steps[e.key]);
            } else if (moves[e.key] !== undefined) {
              e.preventDefault();
              moveBy(moves[e.key]);
            }
          },
        }
      : {};

  const controlProps = {
    onLayout,
    // One accessibility element (a View isn't one by default): VoiceOver/TalkBack focus
    // it and swipe up/down to adjust.
    accessible: true,
    accessibilityRole: 'adjustable' as const,
    accessibilityLabel,
    accessibilityState: { disabled },
    // The aria-value* props, not `accessibilityValue`: react-native maps both on native,
    // but react-native-web reads only these.
    'aria-valuemin': Math.round(min),
    'aria-valuemax': Math.max(Math.round(min), Math.round(max)),
    'aria-valuenow': Math.round(Math.max(min, Math.min(max, value))),
    'aria-valuetext': valueText?.(value),
    accessibilityActions: [{ name: 'increment' }, { name: 'decrement' }],
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
      if (e.nativeEvent.actionName === 'increment') stepOnce(1);
      else if (e.nativeEvent.actionName === 'decrement') stepOnce(-1);
    },
    ...keyboard,
  };

  const track = useMemo(
    () => ({ width, dragging, dragFrac, posFrac }),
    [width, dragging, dragFrac, posFrac],
  );

  return { gesture, width, dragging, dragFrac, posFrac, track, controlProps };
}
