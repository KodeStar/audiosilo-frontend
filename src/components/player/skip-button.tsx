import { Text as RNText } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';

/** Tabular numerals so the label doesn't jitter between one- and two-digit values. */
const TABULAR = { fontVariant: ['tabular-nums' as const] };

/**
 * A directional skip control rendered as plain signed text: back reads `-15s`,
 * forward reads `+30s` (`${sign}${seconds}s`). The sign carries the direction, so
 * it reads at a glance without a glyph - the earlier circular-arrow glyph overlapped
 * the seconds and read as clutter. The label uses the app's semibold Roboto and the
 * caller-provided color; callers own the tap-target size (via `className`) and the
 * accessibility label. `glyphSize` is kept as the type scale knob (mini player passes
 * a smaller value, the full transport a larger one).
 */
export function SkipButton({
  direction,
  seconds,
  onPress,
  onLongPress,
  color,
  glyphSize = 26,
  className = 'h-11 w-11 items-center justify-center',
  hitSlop = 8,
  accessibilityLabel,
}: {
  direction: 'forward' | 'back';
  seconds: number;
  onPress: () => void;
  onLongPress?: () => void;
  color: string;
  glyphSize?: number;
  className?: string;
  hitSlop?: number;
  accessibilityLabel: string;
}) {
  // Scale the label off the same knob the glyph used, so the mini player stays
  // compact and the full transport reads larger.
  const fontSize = Math.round(glyphSize * 0.5);
  const label = `${direction === 'back' ? '-' : '+'}${seconds}s`;
  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={hitSlop}
      className={className}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {/* Raw RN Text + explicit color: the themed <Text> variant injects its own
          color, which NativeWind won't reliably override with the caller's. */}
      <RNText
        allowFontScaling={false}
        className="font-roboto-semibold"
        style={[{ fontSize, lineHeight: fontSize + 2, color }, TABULAR]}
      >
        {label}
      </RNText>
    </AnimatedPressable>
  );
}
