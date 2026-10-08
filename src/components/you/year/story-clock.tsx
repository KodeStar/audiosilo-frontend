import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { colors } from '@/theme/tokens';

import { StoryText } from './story-text';
import { clockPetals, clockRadii, hourAngle } from './story-clock-model';

const AXIS = [0, 6, 12, 18] as const;

/**
 * The listening clock drawn light on a story card's dark ground (STYLEGUIDE section 8):
 * 24 petals from 00 at the top, the busiest hours white, the rest translucent, the
 * busiest hour in the centre. Decorative: the card says the same in words.
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
  const c = size / 2;
  const { inner, outer } = clockRadii(size);
  const petals = clockPetals(hours, size);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <Svg width={size} height={size}>
        {[outer, inner + (outer - inner) / 2].map((r) => (
          <Circle
            key={r}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={colors.white}
            strokeOpacity={0.16}
            strokeDasharray="2 4"
          />
        ))}
        {petals.map((p) => (
          <Path key={p.hour} d={p.d} fill={colors.white} fillOpacity={p.peak ? 1 : 0.45} />
        ))}
      </Svg>
      {AXIS.map((hour) => {
        const a = hourAngle(hour);
        const r = outer + size * 0.055;
        return (
          <StoryText
            key={hour}
            className="absolute text-center font-sans-semibold"
            style={{
              width: 28,
              left: c + Math.cos(a) * r - 14,
              top: c + Math.sin(a) * r - 7,
              fontSize: 10,
              lineHeight: 14,
              opacity: 0.8,
            }}
          >
            {String(hour).padStart(2, '0')}
          </StoryText>
        );
      })}
      <View
        className="absolute items-center justify-center"
        style={{ left: c - inner, top: c - inner, width: inner * 2, height: inner * 2 }}
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
