import { Platform, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { FOCUS_RING_CLASS } from '@/components/ui/text';
import { useSliderControl } from '@/components/ui/use-slider-control';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

const TRACK_H = 6; // slim visual track
const HIT_H = 44; // the touch target (STYLEGUIDE.md section 14)
const THUMB = 16; // resting thumb diameter

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
 * Home/End. Gesture-handler + reanimated move the thumb and fill on the UI thread. The
 * behaviour is `useSliderControl`, shared with the seek bar and the whole-book timeline.
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
  const { gesture, width, dragging, dragFrac, posFrac, controlProps } = useSliderControl({
    value,
    min,
    max,
    step,
    onValueCommit,
    onPreview,
    accessibilityLabel,
    valueText,
    disabled,
  });

  const fillStyle = useAnimatedStyle(() => {
    const f = dragging.get() ? dragFrac.get() : posFrac.get();
    return { transform: [{ translateX: -(1 - f) * width.get() }] };
  });

  const thumbStyle = useAnimatedStyle(() => {
    const f = dragging.get() ? dragFrac.get() : posFrac.get();
    return {
      transform: [{ translateX: f * width.get() - THUMB / 2 }, { scale: 1 + dragging.get() * 0.4 }],
    };
  });

  const fill = tone === 'brand' ? themed.brand : themed.primary;

  return (
    // pan-y: on the web a touch that starts on the slider can still scroll the page.
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <View
        style={{ height: HIT_H }}
        className={cn(
          'justify-center',
          Platform.select({
            web: `cursor-pointer rounded-full ${FOCUS_RING_CLASS}`,
          }),
          disabled && 'opacity-50',
          className,
        )}
        {...controlProps}
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
