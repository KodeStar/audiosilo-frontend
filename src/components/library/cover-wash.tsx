import { View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useDomId } from '@/lib/use-dom-id';

import { type CoverWashProps, useWashLayers } from './cover-wash-model';

/**
 * The cover-coloured wash behind the Now card and the series hero (STYLEGUIDE section 3,
 * "Cover-derived colour"): two radial gradients of the book's `cover_color` at the
 * theme's wash strength (30% light, 42% dark), drawn absolutely over its parent's own
 * surface and under the content, which stays ink and pink (text never sits on raw cover
 * colour). Nothing is drawn without a `cover_color`. Native draws react-native-svg
 * radial gradients; web uses CSS gradients (`cover-wash.web.tsx`). Decorative, so it is
 * hidden from accessibility and takes no touches.
 */
export function CoverWash({ color, variant }: CoverWashProps) {
  const layers = useWashLayers(color, variant);
  const id = useDomId('wash');
  if (!layers) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-0 overflow-hidden"
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          {layers.map((l, i) => (
            <RadialGradient
              key={i}
              id={`${id}-w${i}`}
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
          ))}
        </Defs>
        {layers.map((_, i) => (
          <Rect key={i} width="100%" height="100%" fill={`url(#${id}-w${i})`} />
        ))}
      </Svg>
    </View>
  );
}
