import { forwardRef } from 'react';
import { Pressable, type PressableProps, type View } from 'react-native';

export type AnimatedPressableProps = PressableProps & { className?: string };

// A neutral, semi-transparent ripple that reads on both the light and dark
// surfaces the pressables sit on (Android only; iOS uses the opacity dip below).
const RIPPLE = { color: 'rgba(128,128,128,0.22)', borderless: false, foreground: true };

/**
 * Native counterpart of the web `AnimatedPressable`.
 *
 * ## Why this file exists (the native regression it fixes)
 *
 * The web implementation is a reanimated `Animated.createAnimatedComponent(Pressable)`
 * that is `cssInterop`'d and rendered with an inline `style={animatedStyle}` (a
 * `useAnimatedStyle` result) for a press scale/opacity flourish. On **native** that
 * seam is broken: NativeWind maps `className -> style`, and feeding it an inline
 * reanimated animated-style object at the same target makes the native interop drop
 * the className-resolved styles entirely. The pressable then loses its
 * `flex-row`/background/padding and collapses to the column default with no surface -
 * every card/row/button built on it renders stacked and transparent. (Web resolves
 * className and inline style through a different, additive path, so it's fine there;
 * hence this is a `.native` override and the web file is left untouched.)
 *
 * A plain `<Pressable className=...>` - with NO inline reanimated animated-style -
 * goes through NativeWind's ordinary core-component interop and keeps className
 * correctly (the same path every working `<View className>` uses). So on native we
 * render exactly that. The distinction is specifically the reanimated *object*: a
 * plain `style` FUNCTION (`({pressed}) => ...`) is forwarded and merged fine by the
 * interop (verified on-device - the card/row still lays out correctly), it's only
 * the `useAnimatedStyle` result that clobbers className. So press feedback survives
 * as a lightweight opacity dip on the Pressable's own `pressed` state, plus an
 * `android_ripple` on Android. We drop the reanimated 0.97 scale flourish on native
 * (it only ever worked on web) - correct layout beats the flourish.
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
