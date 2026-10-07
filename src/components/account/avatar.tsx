import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { hslHex } from '@/components/series/people-model';
import { Text } from '@/components/ui/text';
import { initials } from '@/lib/names';
import { useDomId } from '@/lib/use-dom-id';

import { avatarHues } from './account-model';

/**
 * A person's avatar (STYLEGUIDE section 8, "Avatar"): a gradient monogram, two hues from
 * the name, white Bricolage initials. Content colours, the same in both themes, like a
 * cover. Decorative: the name is always written beside it.
 */
export function Avatar({ name, size }: { name: string; size: number }) {
  const id = useDomId('av');
  const [a, b] = avatarHues(name);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2 }}
      className="shrink-0 items-center justify-center overflow-hidden"
    >
      <Svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset={0} stopColor={hslHex(a, 74, 60)} />
            <Stop offset={1} stopColor={hslHex(b, 68, 42)} />
          </LinearGradient>
        </Defs>
        <Rect width={size} height={size} fill={`url(#${id})`} />
      </Svg>
      <Text
        className="font-display text-white"
        style={{
          fontSize: Math.round(size * 0.38),
          lineHeight: Math.round(size * 0.46),
          letterSpacing: -0.02 * size * 0.38,
        }}
      >
        {initials(name)}
      </Text>
    </View>
  );
}
