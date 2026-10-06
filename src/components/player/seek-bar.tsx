import { useTranslation } from 'react-i18next';

import { Slider } from '@/components/ui/slider';
import { formatClock } from '@/lib/format';

/** Screen-reader / keyboard step, seconds. */
const A11Y_STEP = 15;

/**
 * The player's chapter-relative scrubber over the given position/duration: the shared
 * `Slider`, in the `brand` tone by default (progress is the one pink thing). The docked
 * player bar passes `ink`: its whole-book line is already the pink progress there. Tap-to-seek jumps; a
 * drag scrubs with the thumb growing while active and the seek committed on release.
 * The optional `onScrub` reports the previewed position (seconds) during a drag and
 * `null` on release, so a consumer can make its time labels track the scrub. Screen
 * readers and the web arrow keys step 15 seconds; the value reads "41:12 of 1:17:48".
 */
export function SeekBar({
  position,
  duration,
  onSeek,
  onScrub,
  tone = 'brand',
}: {
  position: number;
  duration: number;
  onSeek: (position: number) => void;
  onScrub?: (position: number | null) => void;
  tone?: 'brand' | 'ink';
}) {
  const { t } = useTranslation();
  return (
    <Slider
      value={position}
      max={Math.max(0, duration)}
      step={A11Y_STEP}
      tone={tone}
      onValueCommit={onSeek}
      onPreview={onScrub}
      accessibilityLabel={t('player.seek.label')}
      valueText={(v) =>
        t('player.seek.value', { position: formatClock(v), duration: formatClock(duration) })
      }
    />
  );
}
