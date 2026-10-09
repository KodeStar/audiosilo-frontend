import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { portraitColors } from '@/components/series/people-model';
import { Text } from '@/components/ui/text';
import { initials } from '@/lib/names';
import { useDomId } from '@/lib/use-dom-id';

/** The gap between the avatar and its ring, and the ring's width (the prototype's
 * `0 0 0 2px background, 0 0 0 4px brand`). */
const RING_GAP = 2;
const RING_WIDTH = 2;

/**
 * A person in the household (STYLEGUIDE section 8 "Avatar"): a gradient monogram, two hues
 * from the name (the same deterministic colours as the account page's `Portrait kind="user"`,
 * so a person looks the same everywhere), with Bricolage initials. `ring` is the pink ring
 * that marks who is listening on this device. The ring is drawn outside the avatar's box
 * (like the prototype's box-shadow), so ringing one never moves the layout; leave
 * `RING_GAP + RING_WIDTH` points of room around it. Decorative: the name is always written
 * beside it or in the control's label.
 */
export function PersonAvatar({
  name,
  size,
  ring = false,
}: {
  name: string;
  size: number;
  ring?: boolean;
}) {
  const id = useDomId('pa');
  const c = portraitColors(name, 'user');
  const fontSize = Math.round(size * 0.38);
  return (
    <View
      testID="person-avatar"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
      className="shrink-0"
    >
      {ring ? (
        <View
          testID="person-avatar-ring"
          pointerEvents="none"
          className="absolute rounded-full border-brand"
          style={{
            left: -(RING_GAP + RING_WIDTH),
            top: -(RING_GAP + RING_WIDTH),
            width: size + 2 * (RING_GAP + RING_WIDTH),
            height: size + 2 * (RING_GAP + RING_WIDTH),
            borderWidth: RING_WIDTH,
          }}
        />
      ) : null}
      <View
        className="items-center justify-center overflow-hidden rounded-full"
        style={{ width: size, height: size }}
      >
        <Svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
          <Defs>
            {/* 135deg, as the prototype's linear-gradient. */}
            <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <Stop offset={0} stopColor={c.from} />
              <Stop offset={1} stopColor={c.to} />
            </LinearGradient>
          </Defs>
          <Rect width={size} height={size} fill={`url(#${id})`} />
        </Svg>
        <Text
          className="font-display"
          style={{
            color: c.ink,
            fontSize,
            lineHeight: Math.round(size * 0.46),
            letterSpacing: -0.02 * fontSize,
          }}
        >
          {initials(name)}
        </Text>
      </View>
    </View>
  );
}
