import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors } from '@/theme/tokens';

import { ICON_DATA, type IconName } from './icon-data';

/**
 * Central icon abstraction. Screens import `<Icon name=… />` from here, never an
 * icon library directly, so the backend stays swappable.
 *
 * Icons are vendored as raw SVG path data in `icon-data.ts` and drawn with
 * react-native-svg — the app has NO FontAwesome dependency, so it builds without
 * a FontAwesome Pro token. The glyphs still come from FontAwesome Pro (light for
 * chrome, solid for transport controls); to add one, edit
 * `scripts/glyphs/manifest.mjs` and regenerate `icon-data.ts`
 * (see `scripts/glyphs/README.md`).
 */
export type { IconName };

export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  className?: string;
};

export function Icon({ name, size = 20, color = colors.dark.text, className }: IconProps) {
  const { width, height, path } = ICON_DATA[name];
  // Match @fortawesome/react-native-fontawesome's rendering exactly: a square
  // size×size box with the FA7 overflow viewBox expansion (minY −32, height +64)
  // so paths that bleed past the nominal box aren't clipped, aspect ratio
  // preserved (react-native-svg defaults to xMidYMid meet).
  const icon = (
    <Svg width={size} height={size} viewBox={`0 -32 ${width} ${height + 64}`}>
      <Path d={path} fill={color} />
    </Svg>
  );
  return className ? <View className={className}>{icon}</View> : icon;
}
