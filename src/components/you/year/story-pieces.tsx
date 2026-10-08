import { View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import type { TowerSpine } from './year-model';

/**
 * The drawings on the story cards (`story-card.tsx`): the tower of finished books, the
 * streak's 12 weeks (covers: `story-cover.tsx`). All decorative: each card says the same in words.
 */

/** The tallest the tower stands, in card units (a card is 360 units wide). */
const TOWER_HEIGHT = 250;
const SPINE_GAP = 1.5;

/** The books finished, stacked as spines, the newest on top. Each spine drops in after
 * the one below (Reanimated's layout animation, which follows the system's reduce-motion
 * setting). */
export function Tower({ spines, unit }: { spines: readonly TowerSpine[]; unit: number }) {
  const n = spines.length;
  if (n === 0) return null;
  const h = Math.min(8, Math.max(3, TOWER_HEIGHT / n - SPINE_GAP)) * unit;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center"
      style={{ flexDirection: 'column-reverse', gap: SPINE_GAP * unit }}
    >
      {spines.map((s, i) => (
        <Animated.View
          key={s.key}
          entering={FadeInDown.delay(i * 35).springify()}
          style={{
            width: (70 + s.width * 80) * unit,
            height: h,
            borderRadius: 2 * unit,
            backgroundColor: s.body,
            borderLeftWidth: 4 * unit,
            borderLeftColor: s.band,
          }}
        />
      ))}
    </View>
  );
}

/** A level's warm square (1-5, the stats calendar's scale), a faint one for a day
 * without listening (0), nothing outside the period (null). */
function streakColor(level: number | null): string {
  if (level === null) return 'transparent';
  if (level <= 0) return 'rgba(255, 255, 255, 0.08)';
  return `rgba(255, 214, 140, ${(0.25 + ((Math.min(5, level) - 1) / 4) * 0.75).toFixed(2)})`;
}

/** Listening per day as a little calendar (`streakGrid`): one column per week, Monday at
 * the top, a warm square per day with listening (stronger for more), a faint one without. */
export function StreakGrid({
  weeks,
  unit,
}: {
  weeks: readonly (readonly (number | null)[])[];
  unit: number;
}) {
  const gap = 4 * unit;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row"
      style={{ gap }}
    >
      {weeks.map((week, w) => (
        <View key={w} className="flex-1" style={{ gap }}>
          {week.map((level, d) => (
            <View
              key={d}
              className="aspect-square w-full"
              style={{ borderRadius: 3 * unit, backgroundColor: streakColor(level) }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
