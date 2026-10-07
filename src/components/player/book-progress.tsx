import { View } from 'react-native';

import { progressFractionRemaining } from '@/lib/progress-view';
import { selectBookPosition, usePlayer } from '@/playback/store';

/**
 * The whole-book progress line (the fill is `bg-brand`; `className` styles the track), a
 * per-tick leaf for the compact players (mini, accessory, docked). The engine reports the
 * position about four times a second on web, so the selector returns what the line
 * actually SHOWS (a whole second): zustand compares it by value, and the leaf re-renders
 * only when it moves. (Time left in the playing book: `usePlayingTimeLeft`.)
 */
export function BookProgressLine({ total, className }: { total: number; className: string }) {
  const second = usePlayer((s) => Math.floor(selectBookPosition(s)));
  const { fraction } = progressFractionRemaining(second, total);
  return (
    <View className={className}>
      <View className="h-full bg-brand" style={{ width: `${fraction * 100}%` }} />
    </View>
  );
}
