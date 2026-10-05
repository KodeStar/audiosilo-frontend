import { useEffect, useState } from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/** One sweep of the highlight across the block (STYLEGUIDE.md section 8: 1.4 s). */
const SHIMMER_MS = 1400;

export type SkeletonProps = {
  /** Shape utilities for the placeholder, e.g. "h-4 w-32 rounded-md": the exact shape of
   * what loads in its place, so nothing shifts when it does. */
  className?: string;
  testID?: string;
};

/**
 * A Stacks skeleton (react-native-reusables' Skeleton, reworked): a `muted` block with a
 * soft `card` highlight sweeping across it every 1.4 s. Reduced motion renders it static.
 *
 * Web: one element, the band a CSS gradient moved by a keyframe animation (the
 * `skeleton-shimmer` utility in src/global.css, off under `prefers-reduced-motion`).
 * Native: a react-native-svg gradient band on its own inner view, moved by ONE shared
 * clock that every skeleton on screen reads (so a list of placeholders runs one
 * animation, in step), started by the first and stopped with the last. Animated style
 * and className stay on separate views (why: animated-pressable.native.tsx).
 */
export function Skeleton({ className, testID }: SkeletonProps) {
  if (Platform.OS === 'web') {
    return (
      <View
        testID={testID}
        className={cn('overflow-hidden rounded-md bg-muted skeleton-shimmer', className)}
      />
    );
  }
  return <NativeSkeleton className={className} testID={testID} />;
}

function NativeSkeleton({ className, testID }: SkeletonProps) {
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  return (
    <View
      testID={testID}
      onLayout={onLayout}
      className={cn('overflow-hidden rounded-md bg-muted', className)}
    >
      {!reduced && width > 0 ? <Shimmer width={width} /> : null}
    </View>
  );
}

/** The shared shimmer clock (native): 0 -> 1 every `SHIMMER_MS`, while any shimmer shows. */
const clock = makeMutable(0);
let shimmers = 0;

function useShimmerClock() {
  useEffect(() => {
    shimmers += 1;
    if (shimmers === 1) {
      clock.value = 0;
      clock.value = withRepeat(
        withTiming(1, { duration: SHIMMER_MS, easing: Easing.linear }),
        -1,
        false,
      );
    }
    return () => {
      shimmers -= 1;
      if (shimmers === 0) cancelAnimation(clock);
    };
  }, []);
  return clock;
}

function Shimmer({ width }: { width: number }) {
  const { card } = useThemeColors();
  const progress = useShimmerClock();
  // The band (as wide as the block) sweeps from fully left of it to fully right.
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.value * 2 - 1) * width }],
  }));
  return (
    <Animated.View testID="skeleton-shimmer" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          {/* Each Svg is its own document on native, so a fixed id is safe. */}
          <LinearGradient id="skeleton-band" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={card} stopOpacity={0} />
            <Stop offset="0.5" stopColor={card} stopOpacity={0.55} />
            <Stop offset="1" stopColor={card} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#skeleton-band)" />
      </Svg>
    </Animated.View>
  );
}

/**
 * The app's most common loading silhouette: a short stack of full-width row
 * placeholders (the quiet RowSurface rows of the Libraries/Favourites lists). `count`
 * defaults to 4.
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
          className={cn('h-3.5 rounded-sm', i === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </View>
  );
}
