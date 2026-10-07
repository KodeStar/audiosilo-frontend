import { View } from 'react-native';

import { ProgressBar } from '@/components/ui/progress-bar';
import { cn } from '@/lib/utils';
import { usePlayer } from '@/playback/store';

import { selectPlayingSegment } from './use-playing-segment';

type PlayerSlice = Parameters<Parameters<typeof usePlayer>[0]>[0];

/** The line's resolution: about a pixel of the widest compact player's line. */
const STEPS = 300;

/** How far through the current chapter (else the book, or the file without a whole-book
 * timeline) the player is, 0..1, rounded to 1/300 so a per-tick selector returns the
 * same value until the line would visibly move. */
export function selectChapterFraction(s: PlayerSlice): number {
  const seg = selectPlayingSegment(s);
  return seg ? Math.round((seg.elapsed / seg.length) * STEPS) / STEPS : 0;
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
      className={cn('h-[2.5px]', className)}
    >
      <ProgressBar fraction={fraction} className="h-full" fillTestID="chapter-progress-fill" />
    </View>
  );
}
