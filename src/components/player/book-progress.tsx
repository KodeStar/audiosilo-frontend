import { View } from 'react-native';

import { formatDuration } from '@/lib/format';
import { progressFractionRemaining } from '@/lib/progress-view';
import { wallClockSeconds } from '@/playback/rate';
import { selectBookPosition, usePlayer } from '@/playback/store';

/**
 * Per-tick leaves for the compact players (mini, accessory, docked). The engine reports
 * the position about four times a second on web, so each selector here returns what the
 * leaf actually SHOWS (a whole second, a formatted string): zustand compares it by value,
 * and the leaf re-renders only when its visible output changes.
 */

/** Whole-book time left at the listener's speed, formatted ("5h 27m"; "" when nothing is
 * left or the timeline is unknown). Re-renders only when the text changes. */
export function useBookTimeLeft(total: number): string {
  return usePlayer((s) => formatDuration(wallClockSeconds(total - selectBookPosition(s), s.rate)));
}

/** The whole-book progress line (the fill is `bg-brand`; `className` styles the track).
 * Moves in whole seconds. */
export function BookProgressLine({ total, className }: { total: number; className: string }) {
  const second = usePlayer((s) => Math.floor(selectBookPosition(s)));
  const { fraction } = progressFractionRemaining(second, total);
  return (
    <View className={className}>
      <View className="h-full bg-brand" style={{ width: `${fraction * 100}%` }} />
    </View>
  );
}
