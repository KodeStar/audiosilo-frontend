import { View } from 'react-native';

import { ClockFace } from '@/components/you/stats/clock-face';
import { clockAxis, clockGeometry } from '@/components/you/stats/stats-model';
import { colors } from '@/theme/tokens';

import { StoryText } from './story-text';

/**
 * The listening clock drawn light on a story card's dark ground (STYLEGUIDE section 8):
 * the stats page's clock (`ClockFace`), its busiest hours white and the rest
 * translucent, the busiest hour in the centre. Decorative: the card says the same in words.
 */
export function StoryClock({
  size,
  hours,
  value,
  caption,
}: {
  size: number;
  hours: readonly number[];
  /** The centre: the busiest hour ("22:00") and what it is. */
  value: string;
  caption: string;
}) {
  const { c, r0 } = clockGeometry(size);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <ClockFace
        size={size}
        hours={hours}
        ring={colors.white}
        ringOpacity={0.16}
        fill={(p) => ({ color: colors.white, opacity: p.peak ? 1 : 0.45 })}
      />
      {clockAxis(size).map(({ hour, x, y }) => (
        <StoryText
          key={hour}
          className="absolute text-center font-sans-semibold"
          style={{
            width: 28,
            left: x - 14,
            top: y - 7,
            fontSize: 10,
            lineHeight: 14,
            opacity: 0.8,
          }}
        >
          {String(hour).padStart(2, '0')}
        </StoryText>
      ))}
      <View
        className="absolute items-center justify-center"
        style={{ left: c - r0, top: c - r0, width: r0 * 2, height: r0 * 2 }}
      >
        <StoryText
          className="font-display"
          style={{ fontSize: size * 0.075, lineHeight: size * 0.09 }}
          numberOfLines={1}
        >
          {value}
        </StoryText>
        <StoryText
          className="text-center font-sans"
          style={{ fontSize: Math.max(9, size * 0.042), lineHeight: size * 0.06, opacity: 0.8 }}
          numberOfLines={2}
        >
          {caption}
        </StoryText>
      </View>
    </View>
  );
}
