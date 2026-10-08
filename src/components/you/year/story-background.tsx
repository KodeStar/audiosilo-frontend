import { View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useDomId } from '@/lib/use-dom-id';

import { STORY_THEMES, type StoryTheme } from './story-themes';

/**
 * A story card's ground: its theme's base colour and glows (`story-themes.ts`), drawn
 * with react-native-svg on every platform (no CSS gradients on the web), so the share
 * image rasterises the same drawing. Fills its parent; decorative and touch-through.
 */
export function StoryBackground({ theme }: { theme: StoryTheme }) {
  const id = useDomId('story');
  const { base, layers } = STORY_THEMES[theme];
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-0"
      style={{ backgroundColor: base }}
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          {layers.map((l, i) =>
            l.kind === 'radial' ? (
              <RadialGradient
                key={i}
                id={`${id}-${i}`}
                cx={l.cx}
                cy={l.cy}
                fx={l.cx}
                fy={l.cy}
                rx={l.rx}
                ry={l.ry}
                gradientUnits="objectBoundingBox"
              >
                <Stop offset={0} stopColor={l.color} stopOpacity={l.opacity} />
                <Stop offset={l.fade} stopColor={l.color} stopOpacity={0} />
              </RadialGradient>
            ) : (
              <LinearGradient
                key={i}
                id={`${id}-${i}`}
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
                gradientUnits="objectBoundingBox"
              >
                {l.stops.map(([offset, color]) => (
                  <Stop key={offset} offset={offset} stopColor={color} />
                ))}
              </LinearGradient>
            ),
          )}
        </Defs>
        {layers.map((_, i) => (
          <Rect key={i} width="100%" height="100%" fill={`url(#${id}-${i})`} />
        ))}
      </Svg>
    </View>
  );
}
