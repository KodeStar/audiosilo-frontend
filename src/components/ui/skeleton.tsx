import { cssInterop } from 'nativewind';
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

// Interop'd animated View so `className` (the shape/color) applies alongside the
// animated opacity. See animated-pressable.tsx for why registration is needed.
const AnimatedView = Animated.createAnimatedComponent(View);
cssInterop(AnimatedView, { className: 'style' });

const PULSE_MS = 1000;
const DIM = 0.55;

export type SkeletonProps = {
  /** Shape utilities for the placeholder, e.g. "h-4 w-32 rounded-md". */
  className?: string;
  testID?: string;
};

/**
 * A theme-aware placeholder block that gently pulses its opacity (~1s loop,
 * 0.55<->1). Pass `className` for the shape; the base fill is
 * `bg-gray-300 dark:bg-gray-750`. Reduced motion renders it static.
 */
export function Skeleton({ className, testID }: SkeletonProps) {
  const reduced = useReducedMotion();
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

  return (
    <AnimatedView
      testID={testID}
      style={style}
      className={`bg-gray-300 dark:bg-gray-750 ${className ?? ''}`}
    />
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
