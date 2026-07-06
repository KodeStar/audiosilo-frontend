import { Text as RNText } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { tabularNums } from '@/theme/tokens';

/**
 * A directional skip control rendered as plain signed text: back reads `-15s`,
 * forward reads `+30s` (`${sign}${seconds}s`). The sign carries the direction, so
 * it reads at a glance without a glyph - the earlier circular-arrow glyph overlapped
 * the seconds and read as clutter. The label uses the app's semibold Roboto and the
 * caller-provided color; callers own the tap-target size (via `className`), the label
 * `fontSize` (mini player passes a smaller value, the full transport a larger one),
 * and the accessibility label.
 */
export function SkipButton({
  direction,
  seconds,
  onPress,
  color,
  fontSize = 13,
  className = 'h-11 w-11 items-center justify-center',
  hitSlop = 8,
  accessibilityLabel,
}: {
  direction: 'forward' | 'back';
  seconds: number;
  onPress: () => void;
  color: string;
  fontSize?: number;
  className?: string;
  hitSlop?: number;
  accessibilityLabel: string;
}) {
  const label = `${direction === 'back' ? '-' : '+'}${seconds}s`;
  return (
    <AnimatedPressable
      onPress={onPress}
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
        style={[{ fontSize, lineHeight: fontSize + 2, color }, tabularNums]}
      >
        {label}
      </RNText>
    </AnimatedPressable>
  );
}
