import { useEffect, useId, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
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
 * soft highlight sweeping across it every 1.4 s. Reduced motion renders it static.
 *
 * The highlight is a react-native-svg gradient band moved by a reanimated transform, on
 * its own inner view: animated style and className stay on separate views (why:
 * animated-pressable.native.tsx).
 */
export function Skeleton({ className, testID }: SkeletonProps) {
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

function Shimmer({ width }: { width: number }) {
  const { card } = useThemeColors();
  // A per-instance gradient id: SVG ids are document-global on web.
  const gradientId = `skeleton-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const x = useSharedValue(-width);
  useEffect(() => {
    x.value = -width;
    x.value = withRepeat(
      withTiming(width, { duration: SHIMMER_MS, easing: Easing.linear }),
      -1,
      false,
    );
  }, [width, x]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Animated.View testID="skeleton-shimmer" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={card} stopOpacity={0} />
            <Stop offset="0.5" stopColor={card} stopOpacity={0.55} />
            <Stop offset="1" stopColor={card} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
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
