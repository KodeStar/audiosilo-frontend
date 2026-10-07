import { View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BookCover } from '@/components/library/book-cover';
import { Cover } from '@/components/ui/cover';

import type { StoryCover, TowerSpine } from './year-model';

/**
 * The drawings on the story cards (`story-card.tsx`): the tower of finished books, the
 * streak's 12 weeks, a cover. All decorative: each card says the same in words.
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

/** Listening per day as a little calendar: one column per week, a warm square per day
 * with listening (stronger for more), a faint one without. */
export function StreakGrid({ days, unit }: { days: readonly number[]; unit: number }) {
  const weeks: number[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
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
          {week.map((seconds, d) => (
            <View
              key={d}
              className="aspect-square w-full"
              style={{
                borderRadius: 3 * unit,
                backgroundColor:
                  seconds > 0
                    ? `rgba(255, 214, 140, ${(0.25 + Math.min(1, seconds / 10_800) * 0.75).toFixed(2)})`
                    : 'rgba(255, 255, 255, 0.08)',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

/** A book's cover on a card. `plain` draws it as its title on cloth instead of the art:
 * the second try of a share whose capture could not read an image. */
export function StoryCoverArt({
  connectionId,
  book,
  width,
  plain,
}: {
  connectionId: string;
  book: StoryCover;
  width: number;
  plain: boolean;
}) {
  if (plain) {
    return (
      <View style={{ width, height: width }} className="overflow-hidden rounded-cover">
        <Cover source={null} label={book.title} sublabel={book.author} size={width} rounded="" />
      </View>
    );
  }
  return (
    <BookCover
      connectionId={connectionId}
      libraryId={book.library_id}
      path={book.path}
      width={width}
      title={book.title}
      author={book.author}
      shadow={width > 100 ? 'lg' : 'xs'}
    />
  );
}
