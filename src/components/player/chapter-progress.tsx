import { View } from 'react-native';

import { cn } from '@/lib/utils';
import { selectBookPosition, selectCurrentChapter, usePlayer } from '@/playback/store';

import { currentSegment } from './transport';

type PlayerSlice = Parameters<Parameters<typeof usePlayer>[0]>[0];

/** How far through the current chapter (else the book, or the file without a whole-book
 * timeline) the player is, 0..1, rounded to a thousandth so a per-tick selector returns
 * the same value until the line would visibly move. */
export function selectChapterFraction(s: PlayerSlice): number {
  const np = s.nowPlaying;
  if (!np) return 0;
  const seg = currentSegment({
    total: np.queue.total,
    bookPosition: selectBookPosition(s),
    chapter: selectCurrentChapter(s),
    trackPosition: s.snapshot.position,
    trackDuration: s.snapshot.duration,
  });
  return Math.round((seg.elapsed / seg.length) * 1000) / 1000;
}

/**
 * The chapter progress line of the phone mini player and the iOS accessory pill
 * (STYLEGUIDE "Mini player": 2.5 px, brand): a per-tick leaf, so only the line
 * re-renders as the chapter plays. `className` places and sizes the track.
 */
export function ChapterProgressLine({ className }: { className?: string }) {
  const fraction = usePlayer(selectChapterFraction);
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      className={cn('h-[2.5px] overflow-hidden rounded-full bg-muted', className)}
    >
      <View
        testID="chapter-progress-fill"
        className="h-full rounded-full bg-brand"
        style={{ width: `${fraction * 100}%` }}
      />
    </View>
  );
}
