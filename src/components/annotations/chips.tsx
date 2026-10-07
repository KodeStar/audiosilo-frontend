import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { FELL_ASLEEP_LABEL, PICKABLE_BOOKMARK_LABELS } from '@/api/bookmark-labels';
import { slopTo44 } from '@/components/player/control-pill';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { labelText, toggleLabel } from './labels';

/** What a time chip marks: a bookmark (ink on muted) or a note (the `community` colour,
 * as the note pins on the timeline). */
export type TimeChipTone = 'bookmark' | 'note';

/** The chip's height in rem (`h-7`), for its 44 pt slop. */
const CHIP_REM = 1.75;

/**
 * A place in a book as a mono "17:26:50" chip (STYLEGUIDE section 8, "Bookmark"): ink on
 * muted for a bookmark, `community` for a note. With `onPress` it is the jump there
 * ("Jump to 17:26:50"), with a 44 pt touch on native; without, a plain label (the
 * editor's position).
 */
export function TimeChip({
  position,
  tone = 'bookmark',
  onPress,
  size = 'sm',
}: {
  position: number;
  tone?: TimeChipTone;
  onPress?: () => void;
  /** `md`: the editor's larger chip. */
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  const time = formatClock(position);
  const box = cn(
    'items-center justify-center rounded-md',
    size === 'md' ? 'h-9 px-2.5' : 'h-7 px-2',
    tone === 'note' ? 'bg-community-soft' : 'bg-muted',
  );
  const label = (
    <Text
      className={cn(
        'font-mono',
        size === 'md' ? 'text-sm' : 'text-xs',
        tone === 'note' ? 'text-community' : 'text-foreground',
      )}
      style={tabularNums}
    >
      {time}
    </Text>
  );
  if (!onPress) {
    return (
      <View className={box} accessibilityLabel={time}>
        {label}
      </View>
    );
  }
  const slop = slopTo44(CHIP_REM);
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={t('annotations.jumpTo', { time })}
      onPress={onPress}
      hitSlop={{ top: slop, bottom: slop, left: 4, right: 4 }}
      className={cn(
        box,
        Platform.select({ web: `cursor-pointer hover:opacity-80 ${FOCUS_RING_OFFSET_CLASS}` }),
      )}
    >
      {label}
    </AnimatedPressable>
  );
}

/**
 * A bookmark's label as a quiet kicker ("QUOTE", "RE-LISTEN"), with a moon for the sleep
 * timer's "Fell asleep" marker (`drift`, which an older server can only say through the
 * note: see `isDriftBookmark`). Renders nothing for no label or one this player doesn't
 * know.
 */
export function LabelChip({ label, drift = false }: { label?: string; drift?: boolean }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const text = labelText(t, drift ? FELL_ASLEEP_LABEL : label);
  if (!text) return null;
  return (
    <View className="flex-row items-center gap-1">
      {drift ? <Icon name="moon" size={11} color={themed.mutedForeground} /> : null}
      <Text className="font-sans-semibold text-[11px] uppercase tracking-wider text-muted-foreground">
        {text}
      </Text>
    </View>
  );
}

/** The picker chip's height in rem (`h-8`). */
const PICK_REM = 2;

/**
 * The bookmark editor's label row (STYLEGUIDE section 8, "Chip"): one label or none, as
 * a single-select group of chips (radios with their checked state); tapping the chosen
 * one again clears it (`toggleLabel`). Each chip takes a 44 pt touch on native.
 */
export function LabelPicker({
  value,
  onChange,
}: {
  /** The label key, `''` for none (a key it doesn't offer selects nothing). */
  value: string;
  onChange: (label: string) => void;
}) {
  const { t } = useTranslation();
  const slop = slopTo44(PICK_REM);
  return (
    <View
      role="radiogroup"
      accessibilityLabel={t('annotations.labelGroup')}
      className="flex-row flex-wrap gap-2"
    >
      {PICKABLE_BOOKMARK_LABELS.map((label) => {
        const selected = value === label;
        const name = labelText(t, label) ?? label;
        return (
          <Pressable
            key={label}
            role="radio"
            aria-checked={selected}
            accessibilityState={{ checked: selected }}
            accessibilityLabel={name}
            accessibilityHint={selected ? t('annotations.labelClearHint') : undefined}
            onPress={() => onChange(toggleLabel(value, label))}
            hitSlop={{ top: slop, bottom: slop }}
            testID={`label-${label}`}
            className={cn(
              'h-8 flex-row items-center rounded-full border px-3',
              selected
                ? 'border-primary bg-primary'
                : 'border-border-strong bg-card active:bg-accent hover:bg-accent',
              Platform.select({
                web: `cursor-pointer select-none transition-colors ${FOCUS_RING_OFFSET_CLASS}`,
              }),
            )}
          >
            <Text
              className={cn(
                'font-sans-semibold text-[13px]',
                selected ? 'text-primary-foreground' : 'text-foreground',
              )}
              numberOfLines={1}
            >
              {name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
