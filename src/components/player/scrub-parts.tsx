import { type ReactNode, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';

import { useLatest } from '@/lib/use-latest';

/**
 * The pieces the player's two scrubbers share (the chapter seek bar and the whole-book
 * timeline, STYLEGUIDE section 8 "Seek bar and chapter timeline"): the web hover, the
 * pink playhead with its halo, and the floating tip. Both drive them from
 * `useSliderControl`.
 */

/** The playhead's halo, each side. */
const HALO = 3;

/** What a scrubber's control exposes for the playhead to follow (`useSliderControl`). */
type Track = {
  width: SharedValue<number>;
  dragging: SharedValue<number>;
  dragFrac: SharedValue<number>;
  posFrac: SharedValue<number>;
};

/** Where the playhead is (0..1): under the finger while dragging, else the value. */
export function headFraction(t: Track): number {
  'worklet';
  return t.dragging.get() ? t.dragFrac.get() : t.posFrac.get();
}

/**
 * The web pointer over a scrubber, as a fraction of its width (null when it is not
 * over it, and always on native). Spread `hoverProps` on the control's View.
 */
export function useWebHoverFraction(enabled: boolean) {
  const [hover, setHover] = useState<number | null>(null);
  const hoverProps =
    Platform.OS === 'web' && enabled
      ? {
          onPointerMove: (e: { nativeEvent: { clientX: number }; currentTarget: unknown }) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect?.();
            if (!rect || rect.width <= 0) return;
            setHover(Math.max(0, Math.min(1, (e.nativeEvent.clientX - rect.left) / rect.width)));
          },
          onPointerLeave: () => setHover(null),
        }
      : {};
  return { hover: Platform.OS === 'web' && enabled ? hover : null, hoverProps };
}

/**
 * The pink playhead with its halo, `width` x `height` with its top at `top`, riding the
 * track on the UI thread (a transform per frame, nothing else).
 */
export function Playhead({
  track,
  width,
  height,
  top,
}: {
  track: Track;
  width: number;
  height: number;
  top: number;
}) {
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: headFraction(track) * track.width.get() - width / 2 - HALO }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      className="items-center justify-center rounded-full bg-brand/25"
      style={[
        {
          position: 'absolute',
          left: 0,
          top: top - HALO,
          width: width + HALO * 2,
          height: height + HALO * 2,
        },
        style,
      ]}
    >
      <View className="rounded-full bg-brand" style={{ width, height }} />
    </Animated.View>
  );
}

/**
 * The scrub (or web hover) tip: an ink bubble floating `bottom` points above the
 * scrubber's bottom edge, centred on `x` but kept `edge` points inside the track. It
 * reports itself through `onTip` while it shows, so the caller can clear whatever sits
 * just above the scrubber (the full player's status line, the seek bar's times row).
 */
export function ScrubTip({
  x,
  width,
  edge,
  bottom,
  onTip,
  children,
}: {
  x: number;
  width: number;
  edge: number;
  bottom: number;
  onTip?: (showing: boolean) => void;
  children: ReactNode;
}) {
  const report = useLatest((showing: boolean) => onTip?.(showing));
  useEffect(() => {
    report(true);
    return () => report(false);
  }, [report]);
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        bottom,
        left: Math.max(edge, Math.min(width - edge, x)),
        width: 0,
        alignItems: 'center',
      }}
    >
      <View className="items-center rounded-control bg-primary px-2.5 py-1.5 shadow-overlay">
        {children}
      </View>
    </View>
  );
}
