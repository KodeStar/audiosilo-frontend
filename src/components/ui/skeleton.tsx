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

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

const PULSE_MS = 1000;
const DIM = 0.55;

// The fill is the themed `border` colour as a raw value, on the inner animated layer
// rather than a className: animated style and className stay on separate views (why:
// animated-pressable.native.tsx). `border`, not `muted`: muted barely separates from
// the porcelain page.

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
  const fill = useThemeColors().border;
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

  // Outer: shape/size via className only (no animated style). Inner: the pulsing
  // fill, clipped to the outer's rounding by overflow-hidden.
  return (
    <View testID={testID} className={cn('overflow-hidden', className)}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: fill }, style]} />
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
    <View className={cn('gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-3.5 rounded-sm ${i === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </View>
  );
}
