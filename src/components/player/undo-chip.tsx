import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatClock } from '@/lib/format';
import { cn } from '@/lib/utils';
import { selectUndoFor, undoJump, UNDO_WINDOW_MS, useJumpUndo } from '@/playback/jump-undo';
import { selectBookKey, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

const RING = 22;
const STROKE = 2;
const R = (RING - STROKE) / 2;
const C = RING / 2;
/** The right half of the ring, top to bottom clockwise; the left half is the same path
 * turned half a turn. */
const HALF_ARC = `M ${C} ${C - R} A ${R} ${R} 0 0 1 ${C} ${C + R}`;

/**
 * The ring that empties over the chip's life. Transform-only on every platform (no
 * animated SVG props): each half of the arc is a static half-ring in a half-width
 * window, turned away under the window's edge as the time runs out - the right half
 * first holds the last 180 degrees, then the left.
 *
 * It runs out at `until` (epoch ms), from the share of `UNDO_WINDOW_MS` left when it
 * mounts. Reduced motion: a still, full ring (the chip still goes away on time).
 */
function CountdownRing({ until, color }: { until: number; color: string }) {
  const reduced = useReducedMotion();
  const left = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
      left.set(1);
      return;
    }
    const ms = Math.max(0, until - Date.now());
    left.set(Math.min(1, ms / UNDO_WINDOW_MS));
    left.set(withTiming(0, { duration: ms, easing: Easing.linear }));
    return () => cancelAnimation(left);
  }, [until, reduced, left]);

  // Degrees of arc left, clockwise from the top.
  const rightStyle = useAnimatedStyle(() => {
    const deg = Math.max(0, Math.min(1, left.get())) * 360;
    return { transform: [{ rotate: `${Math.min(deg, 180) - 180}deg` }] };
  });
  const leftStyle = useAnimatedStyle(() => {
    const deg = Math.max(0, Math.min(1, left.get())) * 360;
    return { transform: [{ rotate: `${Math.max(deg, 180) - 180}deg` }] };
  });

  const half = (
    <Svg width={RING} height={RING}>
      <Path d={HALF_ARC} stroke={color} strokeWidth={STROKE} fill="none" />
    </Svg>
  );
  return (
    <View style={{ width: RING, height: RING }} pointerEvents="none">
      <Svg width={RING} height={RING} style={{ position: 'absolute' }}>
        <Circle
          cx={C}
          cy={C}
          r={R}
          stroke={color}
          strokeOpacity={0.25}
          strokeWidth={STROKE}
          fill="none"
        />
      </Svg>
      {/* Right window: the half arc turned back anticlockwise as the time runs out. */}
      <View
        style={{
          position: 'absolute',
          left: C,
          top: 0,
          width: C,
          height: RING,
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={[
            { position: 'absolute', left: -C, top: 0, width: RING, height: RING },
            rightStyle,
          ]}
        >
          {half}
        </Animated.View>
      </View>
      {/* Left window: the half arc starts at the bottom (180) and turns back to it. */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: C,
          height: RING,
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={[{ position: 'absolute', left: 0, top: 0, width: RING, height: RING }, leftStyle]}
        >
          {half}
        </Animated.View>
      </View>
    </View>
  );
}

/** Take the listener back and say so: the chip's press, and anything else that offers
 * the undo (a keyboard shortcut, a menu). Returns whether there was anything to undo. */
export function undoJumpWithToast(t: (key: 'player.undo.restored') => string): boolean {
  const from = undoJump();
  if (from === null) return false;
  toast({ title: t('player.undo.restored'), description: formatClock(from) });
  return true;
}

/**
 * The Undo jump chip (STYLEGUIDE section 8): an ink pill, the undo glyph, "Back to
 * 17:26:50" (where the listener was in the book) and a ring that empties over its
 * 10 seconds. Appears after any jump of more than a minute in the PLAYING book
 * (`src/playback/jump-undo.ts` detects them) and renders nothing otherwise, so a surface
 * can always mount it where the chip belongs (the full player's status line, the dock's
 * right cluster). A press goes back and toasts "Back where you were".
 */
export function UndoChip({ className }: { className?: string }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const bookKey = usePlayer(selectBookKey);
  const jump = useJumpUndo(selectUndoFor(bookKey));
  if (!jump) return null;

  const label = t('player.undo.label', { time: formatClock(jump.from) });
  return (
    <Animated.View
      key={jump.at}
      entering={FadeIn.duration(320).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(200).reduceMotion(ReduceMotion.System)}
    >
      <AnimatedPressable
        onPress={() => undoJumpWithToast(t)}
        hitSlop={5}
        accessibilityRole="button"
        accessibilityLabel={label}
        className={cn(
          'h-[34px] flex-row items-center gap-2 self-center rounded-full bg-primary pl-3 pr-1.5 shadow-overlay',
          Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
          className,
        )}
      >
        {/* The undo glyph: the vendored rotate arrow, mirrored (no separate glyph). */}
        <View style={{ transform: [{ scaleX: -1 }] }}>
          <Icon name="rotate" size={14} color={themed.primaryForeground} />
        </View>
        <Text
          variant="label"
          className="text-[13px] text-primary-foreground"
          numberOfLines={1}
          style={tabularNums}
        >
          {label}
        </Text>
        <CountdownRing until={jump.until} color={themed.primaryForeground} />
      </AnimatedPressable>
    </Animated.View>
  );
}
