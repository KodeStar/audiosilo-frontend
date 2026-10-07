import { type ReactNode, useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

export type RingLook = {
  /** The ring's outer size, points. */
  size: number;
  stroke: number;
  /** The arc. */
  color: string;
  /** The track under the arc (default: the arc's colour at `trackOpacity`). */
  trackColor?: string;
  trackOpacity?: number;
  /** Centred in the ring (a glyph, a number). */
  children?: ReactNode;
};

const clamp01 = (v: number) => {
  'worklet';
  return Math.max(0, Math.min(1, v));
};

/**
 * The ring drawn from a 0..1 shared value: the arc runs clockwise from the top for that
 * share of the circle. Transform-only on every platform (no animated SVG props, which
 * the web and older Android drivers handle badly): each half of the arc is a static
 * half-ring in a half-width window, turned away under the window's edge as the value
 * falls - the right half holds the last 180 degrees, then the left.
 */
function RingArcs({
  value,
  size,
  stroke,
  color,
  trackColor,
  trackOpacity = 1,
  children,
}: RingLook & { value: SharedValue<number> }) {
  const r = (size - stroke) / 2;
  const c = size / 2;
  // The right half of the ring, top to bottom clockwise; the left half is the same path
  // turned half a turn.
  const halfArc = `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r}`;
  const rightStyle = useAnimatedStyle(() => {
    const deg = clamp01(value.get()) * 360;
    return { transform: [{ rotate: `${Math.min(deg, 180) - 180}deg` }] };
  });
  const leftStyle = useAnimatedStyle(() => {
    const deg = clamp01(value.get()) * 360;
    return { transform: [{ rotate: `${Math.max(deg, 180) - 180}deg` }] };
  });
  const half = (
    <Svg width={size} height={size}>
      <Path d={halfArc} stroke={color} strokeWidth={stroke} fill="none" />
    </Svg>
  );
  const window = {
    position: 'absolute',
    top: 0,
    width: c,
    height: size,
    overflow: 'hidden',
  } as const;
  return (
    <View
      style={{ width: size, height: size }}
      className="items-center justify-center"
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
        <Circle
          cx={c}
          cy={c}
          r={r}
          stroke={trackColor ?? color}
          strokeOpacity={trackOpacity}
          strokeWidth={stroke}
          fill="none"
        />
      </Svg>
      {/* Right window: the half arc turned back anticlockwise as the value falls. */}
      <View style={{ ...window, left: c }}>
        <Animated.View
          style={[
            { position: 'absolute', left: -c, top: 0, width: size, height: size },
            rightStyle,
          ]}
        >
          {half}
        </Animated.View>
      </View>
      {/* Left window: the half arc starts at the bottom (180) and turns back to it. */}
      <View style={{ ...window, left: 0 }}>
        <Animated.View
          style={[{ position: 'absolute', left: 0, top: 0, width: size, height: size }, leftStyle]}
        >
          {half}
        </Animated.View>
      </View>
      {children}
    </View>
  );
}

/**
 * A ring filled to `fraction` (0..1), redrawn when it changes (a countdown the caller
 * already ticks, like the sleep timer's grace card). Decorative: say the figure in words
 * beside it.
 */
export function ProgressRing({ fraction, ...look }: RingLook & { fraction: number }) {
  const value = useSharedValue(clamp01(fraction));
  useEffect(() => {
    value.set(clamp01(fraction));
  }, [fraction, value]);
  return <RingArcs value={value} {...look} />;
}

/**
 * A ring that empties by itself, running out at `until` (epoch ms) from the share of
 * `windowMs` left when it mounts, on the UI thread (the undo chip's ten seconds, the end
 * credits' auto-play countdown). Reduced motion: a still, full ring (the caller still
 * ends on time).
 */
export function CountdownRing({
  until,
  windowMs,
  ...look
}: RingLook & { until: number; windowMs: number }) {
  const reduced = useReducedMotion();
  const value = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
      value.set(1);
      return;
    }
    const ms = Math.max(0, until - Date.now());
    value.set(windowMs > 0 ? Math.min(1, ms / windowMs) : 0);
    value.set(withTiming(0, { duration: ms, easing: Easing.linear }));
    return () => cancelAnimation(value);
  }, [until, windowMs, reduced, value]);
  return <RingArcs value={value} {...look} />;
}
