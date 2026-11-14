import { Text as RNText, type StyleProp, type ViewStyle } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { scaleCapped, useFontScale } from '@/lib/text-scale';
import { tabularNums } from '@/theme/tabular-nums';

/** How far the label follows the text size inside a fixed button (the mini player's 44
 * box, the iOS accessory pill): "-15s" still fits at this. */
export const SKIP_LABEL_MAX_SCALE = 1.3;

/**
 * A directional skip control rendered as plain signed text: back reads `-15s`,
 * forward reads `+30s` (`${sign}${seconds}s`). The sign carries the direction, so
 * it reads at a glance without a glyph - the earlier circular-arrow glyph overlapped
 * the seconds and read as clutter. The label uses semibold Figtree (`font-sans-semibold`) and the
 * caller-provided color; callers own the tap-target size (via `className`), the label
 * `fontSize` (mini player passes a smaller value, the full transport a larger one),
 * and the accessibility label.
 *
 * The label follows the text size (fe#267) up to `maxFontScale`, through the shared
 * text scale (`@/lib/text-scale`) so the web follows the browser's font size the same
 * way. The OS's own scaling is off on the text node only because the size is already
 * scaled here: it would apply twice. The full transport scales its buttons and this size
 * together (`controlScale`) and passes `maxFontScale` 1.
 */
export function SkipButton({
  direction,
  seconds,
  onPress,
  color,
  fontSize = 13,
  maxFontScale = SKIP_LABEL_MAX_SCALE,
  className = 'h-11 w-11 items-center justify-center',
  hitSlop = 8,
  style,
  accessibilityLabel,
}: {
  direction: 'forward' | 'back';
  seconds: number;
  onPress: () => void;
  color: string;
  fontSize?: number;
  /** The most the label grows with the text size (1 = a size already scaled). */
  maxFontScale?: number;
  className?: string;
  hitSlop?: number;
  /** Extra style for the pressable (a fixed size). */
  style?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
}) {
  const label = `${direction === 'back' ? '-' : '+'}${seconds}s`;
  const size = scaleCapped(fontSize, useFontScale(), maxFontScale);
  return (
    <AnimatedPressable
      onPress={onPress}
      hitSlop={hitSlop}
      className={className}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <RNText
        allowFontScaling={false}
        className="font-sans-semibold"
        style={[{ fontSize: size, lineHeight: size + 2, color }, tabularNums]}
      >
        {label}
      </RNText>
    </AnimatedPressable>
  );
}
