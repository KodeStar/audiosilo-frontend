import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { colors } from '@/theme/tokens';

const TRACK_H = 6; // slim visual track (h-1.5)
const HIT_H = 44; // generous touch/hit area
const THUMB = 14; // resting thumb diameter
/** Accessibility increment/decrement step, seconds. */
const A11Y_STEP = 15;

function clampFrac(v: number): number {
  'worklet';
  return Math.max(0, Math.min(1, v));
}

/**
 * Draggable scrubber over the given position/duration. Tap-to-seek jumps; a drag
 * scrubs with the thumb growing while active and the seek committed on release.
 * The optional `onScrub` reports the previewed position (seconds) during a drag
 * and `null` on release, so a consumer can make its time labels track the scrub.
 *
 * The visual track stays slim (6px) but the touch target is 44px tall. Built on
 * gesture-handler + reanimated so the thumb/fill move on the UI thread; works on
 * web, iOS and Android (the app mounts a GestureHandlerRootView at its root).
 */
export function SeekBar({
  position,
  duration,
  onSeek,
  onScrub,
}: {
  position: number;
  duration: number;
  onSeek: (position: number) => void;
  onScrub?: (position: number | null) => void;
}) {
  const { t } = useTranslation();
  const width = useSharedValue(0);
  const dragging = useSharedValue(0);
  const dragFrac = useSharedValue(0);
  const posFrac = useSharedValue(0);

  // Track the live position from props on the UI thread (reads inside worklets).
  const propFrac = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  posFrac.value = propFrac;

  const gesture = useMemo(() => {
    const preview = (sec: number | null) => onScrub?.(sec);
    const commit = (f: number) => onSeek(f * (duration > 0 ? duration : 0));

    const pan = Gesture.Pan()
      .onBegin((e) => {
        dragging.value = 1;
        const f = clampFrac(width.value > 0 ? e.x / width.value : 0);
        dragFrac.value = f;
        if (duration > 0) runOnJS(preview)(f * duration);
      })
      .onUpdate((e) => {
        const f = clampFrac(width.value > 0 ? e.x / width.value : 0);
        dragFrac.value = f;
        if (duration > 0) runOnJS(preview)(f * duration);
      })
      .onEnd((e) => {
        const f = clampFrac(width.value > 0 ? e.x / width.value : 0);
        posFrac.value = f; // hold position at release, avoids a snap-back
        runOnJS(commit)(f);
      })
      .onFinalize(() => {
        dragging.value = 0;
        runOnJS(preview)(null);
      });

    // Use gesture-handler's default tap window (500ms) rather than a tight 250ms cap:
    // a deliberate, slightly-slow press-and-release with no drag should still seek
    // (like the old Pressable onPress). A too-short cap on a motionless press activates
    // neither Tap nor Pan, so the tap would silently no-op.
    const tap = Gesture.Tap().onEnd((e) => {
      const f = clampFrac(width.value > 0 ? e.x / width.value : 0);
      posFrac.value = f;
      runOnJS(commit)(f);
    });

    return Gesture.Race(pan, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shared values are stable refs
  }, [duration, onSeek, onScrub]);

  const fillStyle = useAnimatedStyle(() => {
    const f = dragging.value ? dragFrac.value : posFrac.value;
    return { transform: [{ translateX: -(1 - f) * width.value }] };
  });

  const thumbStyle = useAnimatedStyle(() => {
    const f = dragging.value ? dragFrac.value : posFrac.value;
    return {
      transform: [{ translateX: f * width.value - THUMB / 2 }, { scale: 1 + dragging.value * 0.6 }],
    };
  });

  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
  };

  const stepSeek = (delta: number) => {
    if (duration <= 0) return;
    onSeek(Math.max(0, Math.min(duration, position + delta)));
  };

  return (
    <GestureDetector gesture={gesture}>
      <View
        onLayout={onLayout}
        style={{ height: HIT_H }}
        className="justify-center"
        accessibilityRole="adjustable"
        accessibilityValue={{
          min: 0,
          max: Math.max(0, Math.round(duration)),
          now: Math.max(0, Math.round(position)),
        }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'increment') stepSeek(A11Y_STEP);
          else if (e.nativeEvent.actionName === 'decrement') stepSeek(-A11Y_STEP);
        }}
        accessibilityLabel={t('player.seek.label')}
      >
        <View
          style={{ height: TRACK_H }}
          className="overflow-hidden rounded-full bg-gray-400/70 dark:bg-gray-700"
        >
          <Animated.View
            style={[
              { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, borderRadius: 999 },
              { backgroundColor: colors.primary },
              fillStyle,
            ]}
          />
        </View>
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: 0,
              top: '50%',
              marginTop: -THUMB / 2,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: colors.primary,
            },
            thumbStyle,
          ]}
        />
      </View>
    </GestureDetector>
  );
}
