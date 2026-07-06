import { Text as RNText, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';

/** Tabular numerals so the digit doesn't jitter as it centers in the glyph. */
const TABULAR = { fontVariant: ['tabular-nums' as const] };

/**
 * A directional skip control: an Audible-style circular arrow (clockwise for
 * forward, counter-clockwise for back) with the skip amount in seconds nested in
 * its centre. The bare "30s" text used before said nothing about direction; the
 * rotate glyph makes forward-vs-back read at a glance.
 *
 * The seconds number sits absolutely centred over the glyph, nudged down a hair so
 * it lands inside the ring (whose opening/arrowhead is at the top). The label font
 * scales with the glyph. Callers own the tap target size + accessibility label.
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
  // Number sized to sit inside the ring; the glyph's usable interior is ~40% of
  // its box, so ~0.42x reads cleanly for one- or two-digit values.
  const fontSize = Math.round(glyphSize * 0.42);
  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={hitSlop}
      className={className}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <View
        style={{
          width: glyphSize,
          height: glyphSize,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon
          name={direction === 'forward' ? 'rotate-right' : 'rotate-left'}
          size={glyphSize}
          color={color}
        />
        <RNText
          allowFontScaling={false}
          className="font-roboto-semibold"
          style={[
            {
              position: 'absolute',
              top: glyphSize * 0.5 - fontSize * 0.62,
              width: glyphSize,
              textAlign: 'center',
              fontSize,
              lineHeight: fontSize + 1,
              color,
            },
            TABULAR,
          ]}
        >
          {seconds}
        </RNText>
      </View>
    </AnimatedPressable>
  );
}
