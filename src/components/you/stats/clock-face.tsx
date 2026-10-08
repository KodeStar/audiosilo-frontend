import { useMemo } from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

import { type ClockPetal, clockGeometry, clockPetals, clockRings } from './stats-model';

/**
 * The listening clock's drawing (STYLEGUIDE section 8): two dashed rings and 24 radial
 * petals from 00 at the top, as long as each hour's listening. The one geometry behind
 * the stats page's clock (`ListeningClock`) and the story card's (`StoryClock`); each
 * colours it (`fill`) and lays its own labels and centre over it.
 */
export function ClockFace({
  size,
  hours,
  ring,
  ringOpacity,
  fill,
}: {
  size: number;
  hours: readonly number[];
  ring: string;
  ringOpacity?: number;
  fill: (petal: ClockPetal) => { color: string; opacity: number };
}) {
  const petals = useMemo(() => clockPetals(hours, size), [hours, size]);
  const { c } = clockGeometry(size);
  return (
    <Svg width={size} height={size} pointerEvents="none">
      {clockRings(size).map((r) => (
        <Circle
          key={r}
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={ring}
          strokeOpacity={ringOpacity}
          strokeDasharray="2 4"
        />
      ))}
      {petals.map((p) => {
        const f = fill(p);
        return <Path key={p.hour} d={p.d} fill={f.color} fillOpacity={f.opacity} />;
      })}
    </Svg>
  );
}
