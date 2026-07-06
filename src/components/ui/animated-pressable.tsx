import { cssInterop } from 'nativewind';
import { forwardRef } from 'react';
import { Pressable, type PressableProps, type View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

// An animated Pressable that also honours NativeWind `className`. NativeWind only
// interops components it knows about (see react-native-css-interop's wrapJSX), and
// `Animated.createAnimatedComponent(Pressable)` is not one of them, so we register
// it: cssInterop resolves className -> style and merges it with the animated style
// prop we pass (reanimated accepts the resulting style array).
const AnimatedPressableBase = Animated.createAnimatedComponent(Pressable);
cssInterop(AnimatedPressableBase, { className: 'style' });

const PRESS_IN_MS = 120;
const RELEASE_MS = 180;

export type AnimatedPressableProps = PressableProps & { className?: string };

/**
 * Drop-in Pressable with tactile press feedback: a subtle scale-down (0.97) and
 * dip in opacity on press-in, easing back on release (120ms in / 180ms out,
 * ease-out). Respects reduced-motion by skipping the scale (opacity only). Works
 * on web, iOS and Android (reanimated 4). Forwards every Pressable prop, including
 * accessibility props and the caller's own onPressIn/onPressOut.
 */
export const AnimatedPressable = forwardRef<View, AnimatedPressableProps>(
  function AnimatedPressable({ onPressIn, onPressOut, style, ...props }, ref) {
    const reduced = useReducedMotion();
    const pressed = useSharedValue(0);

    const animatedStyle = useAnimatedStyle(() => ({
      opacity: 1 - pressed.value * 0.1,
      transform: reduced ? [] : [{ scale: 1 - pressed.value * 0.03 }],
    }));

    // Merge (not clobber) a caller-supplied `style`: destructure it out of props and
    // put it AFTER the animated style so both apply. Spreading `{...props}` with a
    // `style` in it would instead override `animatedStyle` and silently kill the press
    // feedback - and it must match the .native variant's merge contract (drop-in).
    return (
      <AnimatedPressableBase
        ref={ref}
        style={[animatedStyle, style]}
        onPressIn={(e) => {
          pressed.value = withTiming(1, { duration: PRESS_IN_MS, easing: Easing.out(Easing.ease) });
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          pressed.value = withTiming(0, { duration: RELEASE_MS, easing: Easing.out(Easing.ease) });
          onPressOut?.(e);
        }}
        {...props}
      />
    );
  },
);
