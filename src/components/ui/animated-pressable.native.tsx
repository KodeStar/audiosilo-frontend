import { forwardRef } from 'react';
import { Pressable, type PressableProps, type View } from 'react-native';

export type AnimatedPressableProps = PressableProps & { className?: string };

// A neutral, semi-transparent ripple that reads on both the light and dark
// surfaces the pressables sit on (Android only; iOS uses the opacity dip below).
const RIPPLE = { color: 'rgba(128,128,128,0.22)', borderless: false, foreground: true };

/**
 * Native counterpart of the web `AnimatedPressable`.
 *
 * ## Why this file exists (the native regression it fixed)
 *
 * The web implementation is a reanimated `Animated.createAnimatedComponent(Pressable)`
 * rendered with an inline `style={animatedStyle}` (a `useAnimatedStyle` result) for a
 * press scale/opacity flourish. Under NativeWind (the styling engine before Uniwind)
 * that seam broke on **native**: NativeWind mapped `className -> style`, and feeding
 * it an inline reanimated animated-style object at the same target made its native
 * interop drop the className-resolved styles entirely. The pressable then lost its
 * `flex-row`/background/padding and collapsed to the column default with no surface -
 * every card/row/button built on it rendered stacked and transparent. (Web resolved
 * className and inline style through a different, additive path, so it was fine
 * there; hence this is a `.native` override and the web file is separate.)
 *
 * A plain `<Pressable className=...>` - with NO inline reanimated animated-style -
 * keeps className correctly (the same path every working `<View className>` uses), so
 * on native we render exactly that. A plain `style` FUNCTION (`({pressed}) => ...`)
 * merges fine with className (verified on-device). So press feedback is a lightweight
 * opacity dip on the Pressable's own `pressed` state, plus an `android_ripple` on
 * Android; the reanimated 0.97 scale flourish is web-only. This shape is kept under
 * Uniwind (it renders the same); whether Uniwind would keep className next to a
 * reanimated style object has not been verified on device.
 *
 * Forwards every Pressable prop (including accessibility props and the caller's own
 * onPressIn/onPressOut) and the ref, so it stays a drop-in for the ~30 call sites.
 */
export const AnimatedPressable = forwardRef<View, AnimatedPressableProps>(
  function AnimatedPressable({ android_ripple, style, disabled, ...props }, ref) {
    return (
      <Pressable
        ref={ref}
        disabled={disabled}
        android_ripple={android_ripple ?? RIPPLE}
        style={(state) => [
          typeof style === 'function' ? style(state) : style,
          !disabled && state.pressed ? { opacity: 0.72 } : null,
        ]}
        {...props}
      />
    );
  },
);
