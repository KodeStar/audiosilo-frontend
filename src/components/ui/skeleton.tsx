import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/theme/theme-provider';

const PULSE_MS = 1000;
const DIM = 0.55;

// The fill color as a raw value (gray-300 light / gray-750 dark). It rides on the
// inner animated layer as an explicit style, NOT a className: passing a
// `useAnimatedStyle` result to a `cssInterop`'d (className-driven) component makes
// NativeWind's native interop drop the className-resolved styles entirely (the same
// regression that forced animated-pressable.native.tsx). So the shape/size stay on a
// plain interop'd `View` (no animated style) and only the opacity pulse - with the
// fill baked in as a raw color - lives on the inner `Animated.View`.
const FILL = { light: '#d1d5db', dark: '#2c3340' } as const;

export type SkeletonProps = {
  /** Shape utilities for the placeholder, e.g. "h-4 w-32 rounded-md". */
  className?: string;
  testID?: string;
};

/**
 * A theme-aware placeholder block that gently pulses its opacity (~1s loop,
 * 0.55<->1). Pass `className` for the shape (size + rounding). Reduced motion
 * renders it static.
 */
export function Skeleton({ className, testID }: SkeletonProps) {
  const reduced = useReducedMotion();
  const { scheme } = useTheme();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withTiming(DIM, { duration: PULSE_MS, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [reduced, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // Outer: shape/size via className only (no animated style -> native interop keeps
  // it). Inner: the pulsing fill, clipped to the outer's rounding by overflow-hidden.
  return (
    <View testID={testID} className={`overflow-hidden ${className ?? ''}`}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: FILL[scheme] }, style]} />
    </View>
  );
}

/**
 * The app's most common loading silhouette: a short stack of full-width
 * elevated-row placeholders (matching the quiet surface rows used across the
 * Libraries/Favourites lists). `count` defaults to 4.
 */
export function RowSkeletonList({ count = 4 }: { count?: number }) {
  return (
    <View className="gap-2 pt-1">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-xl" />
      ))}
    </View>
  );
}

export type SkeletonTextProps = {
  /** Number of lines (default 2); the last is rendered shorter. */
  lines?: number;
  /** Applied to the wrapping column (e.g. spacing/margins). */
  className?: string;
};

/** A stack of skeleton text lines shaped like a paragraph. */
export function SkeletonText({ lines = 2, className }: SkeletonTextProps) {
  return (
    <View className={`gap-2 ${className ?? ''}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-3.5 rounded ${i === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </View>
  );
}
