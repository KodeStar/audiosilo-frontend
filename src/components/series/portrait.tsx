import { View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { Text } from '@/components/ui/text';
import { hashString } from '@/lib/monogram';
import { initials } from '@/lib/names';
import { useDomId } from '@/lib/use-dom-id';

import { portraitColors, type PortraitKind } from './people-model';

const BARS = 24;

/** The gap between a ringed portrait and its ring, and the ring's width (the prototype's
 * `0 0 0 2px background, 0 0 0 4px brand`). */
const RING_GAP = 2;
const RING_WIDTH = 2;
/** The room a portrait that can be ringed keeps around its box (`ring`). */
export const RING_ROOM = RING_GAP + RING_WIDTH;

/**
 * A person's portrait (STYLEGUIDE section 8, "Avatar, portrait"): no photos, a monogram
 * on colours from the name. An author is a pale gradient disc with deep initials; a
 * narrator a rounded square in a deeper gradient with white initials over a faint
 * waveform; a listener (`user`: the account page, the people of the household, the house
 * rows) a vivid gradient disc with white initials, the same colours wherever the name
 * shows, so a person looks the same everywhere. Decorative: the name is always written
 * beside it.
 *
 * `ring` (a `user` disc) is the pink ring that marks who is listening on this device. Pass
 * it, true or false, wherever a ring can show: the portrait then keeps `RING_ROOM` around
 * itself and draws the ring in that room, so ringing one never moves the layout. Leave it
 * out where no ring ever shows.
 */
export function Portrait({
  name,
  kind,
  size,
  ring,
}: {
  name: string;
  kind: PortraitKind;
  size: number;
  ring?: boolean;
}) {
  const id = useDomId('pt');
  const c = portraitColors(name, kind);
  const narrator = kind === 'narrator';
  const disc = (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: narrator ? size * 0.28 : size / 2,
        boxShadow: '0px 1px 1px rgba(18, 28, 54, 0.1), 0px 4px 8px -2px rgba(18, 28, 54, 0.14)',
      }}
      className="items-center justify-center overflow-hidden"
    >
      <Svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
        <Defs>
          {narrator ? (
            <RadialGradient id={id} cx="0.3" cy="0.2" rx="1.2" ry="0.9">
              <Stop offset={0} stopColor={c.from} />
              <Stop offset={1} stopColor={c.to} />
            </RadialGradient>
          ) : (
            <LinearGradient id={id} x1="0.2" y1="0" x2="0.8" y2="1">
              <Stop offset={0} stopColor={c.from} />
              <Stop offset={1} stopColor={c.to} />
            </LinearGradient>
          )}
        </Defs>
        <Rect width={size} height={size} fill={`url(#${id})`} />
        {narrator
          ? Array.from({ length: BARS }, (_, i) => {
              const amp = (0.15 + ((hashString(name + i) % 100) / 100) * 0.65) * size * 0.4;
              const step = (size * 0.8) / BARS;
              return (
                <Rect
                  key={i}
                  x={size * 0.1 + i * step + step * 0.15}
                  y={size / 2 - amp / 2}
                  width={step * 0.55}
                  height={amp}
                  rx={step * 0.27}
                  fill={c.ink}
                  fillOpacity={0.28}
                />
              );
            })
          : null}
      </Svg>
      <Text
        className="font-display"
        style={{
          color: c.ink,
          fontSize: Math.round(size * 0.36),
          lineHeight: Math.round(size * 0.42),
          letterSpacing: -0.02 * size * 0.36,
        }}
      >
        {initials(name)}
      </Text>
    </View>
  );
  if (ring === undefined) return disc;
  return (
    <View
      testID="portrait-ringed"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="shrink-0"
      style={{ margin: RING_ROOM }}
    >
      {ring ? (
        <View
          testID="portrait-ring"
          pointerEvents="none"
          className="absolute rounded-full border-brand"
          style={{
            left: -RING_ROOM,
            top: -RING_ROOM,
            width: size + 2 * RING_ROOM,
            height: size + 2 * RING_ROOM,
            borderWidth: RING_WIDTH,
          }}
        />
      ) : null}
      {disc}
    </View>
  );
}
