import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Platform, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { formatClock, formatDurationOrZero } from '@/lib/format';
import { useLatest } from '@/lib/use-latest';
import { cn } from '@/lib/utils';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { selectBookPosition, selectCurrentChapter, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { trackLabel } from '../transport';
import { chapterRows, type ChapterRow } from './companion-model';

const ROW_H = 52;

type RowProps = {
  index: number;
  label: string;
  state: ChapterRow['state'] | null;
  /** What the right-hand column says ("in 2h 4m", "-12:40"), already formatted. */
  side: string;
  /** Stable across ticks (`useLatest`), so it never breaks the memo. */
  onPress: (index: number) => void;
};

/** One chapter: its number (a play glyph on the current one), title, and a tick, the
 * time left in it, or how long until it starts. Memoised on primitives, so a tick only
 * redraws the rows whose words changed (the current one each second, an ahead one when
 * its minute turns). */
const Row = memo(function Row({ index, label, state, side, onPress }: RowProps) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const current = state === 'current';
  const past = state === 'past';
  return (
    <AnimatedPressable
      onPress={() => onPress(index)}
      accessibilityRole="button"
      accessibilityState={{ selected: current }}
      accessibilityLabel={
        current
          ? t('player.companion.chapterNow', { chapter: label })
          : side
            ? `${label}, ${side}`
            : label
      }
      style={{ height: ROW_H }}
      className={cn(
        'flex-row items-center gap-3 rounded-control px-3',
        current ? 'bg-brand-soft' : 'active:bg-accent',
        Platform.select({
          web: `cursor-pointer ${current ? '' : 'hover:bg-accent'} ${FOCUS_RING_CLASS}`,
        }),
      )}
    >
      <View className="w-7 items-center">
        {current ? (
          <Icon name="play" size={12} color={themed.brandInk} />
        ) : (
          <Text variant="caption" style={tabularNums}>
            {index + 1}
          </Text>
        )}
      </View>
      <Text
        numberOfLines={1}
        className={cn(
          'flex-1 text-sm',
          current ? 'font-sans-semibold text-brand-ink' : past ? 'text-muted-foreground' : '',
        )}
      >
        {label}
      </Text>
      {past ? (
        <Icon name="check" size={13} color={themed.subtleForeground} />
      ) : side ? (
        <Text
          variant="caption"
          style={tabularNums}
          className={current ? 'font-sans-semibold text-brand-ink' : undefined}
        >
          {side}
        </Text>
      ) : null}
    </AnimatedPressable>
  );
});

/**
 * The companion's chapter list for the playing book (STYLEGUIDE section 8: the current
 * chapter marked, the ones behind ticked, the later ones "in 2h 4m" at the listener's
 * speed). A tap seeks there: a jump, so the Undo chip follows. A book without a
 * whole-book timeline lists its files instead. `virtualized` (in a sheet, or as the
 * desktop column's own scroller) opens on the current chapter; inline in a scrolling
 * page it is a plain list.
 */
export function ChaptersPanel({
  virtualized = false,
  onSelected,
}: {
  virtualized?: boolean;
  /** After a tap (a sheet closes itself). */
  onSelected?: () => void;
}) {
  const { t } = useTranslation();
  const queue = usePlayer((s) => s.nowPlaying?.queue ?? null);
  const title = usePlayer((s) => s.nowPlaying?.title ?? '');
  const total = queue?.total ?? 0;
  const perTrack = total <= 0;
  // Whole seconds: the right-hand column's resolution.
  const position = usePlayer((s) => Math.floor(selectBookPosition(s)));
  const chapterIndex = usePlayer((s) => selectCurrentChapter(s)?.index ?? 0);
  const trackIndex = usePlayer((s) => s.snapshot.trackIndex);
  const rate = usePlayer((s) => s.rate);
  const seekBook = usePlayer((s) => s.seekBook);
  const goToTrack = usePlayer((s) => s.goToTrack);

  const labels = useMemo(() => {
    if (!queue) return [];
    return perTrack
      ? queue.tracks.map(
          (tr, i) =>
            prettifyChapterTitle(trackLabel(tr, title)) ||
            t('player.controls.fileNumber', { number: i + 1 }),
        )
      : queue.chapters.map((c) => chapterLabel(c, t));
  }, [queue, perTrack, title, t]);
  const onPress = useLatest((i: number) => {
    if (perTrack) void goToTrack(i);
    else {
      const c = queue?.chapters[i];
      if (c) void seekBook(c.book_offset);
    }
    onSelected?.();
  });
  if (!queue || labels.length === 0) return null;

  const current = perTrack ? trackIndex : chapterIndex;
  const rows: (ChapterRow | null)[] = perTrack
    ? labels.map((_, i) =>
        i < current ? { state: 'past' } : i === current ? { state: 'current', left: 0 } : null,
      )
    : chapterRows(queue.chapters, position, current, rate);
  const sideOf = (row: ChapterRow | null): string =>
    !row || row.state === 'past'
      ? ''
      : row.state === 'current'
        ? row.left > 0
          ? `-${formatClock(row.left)}`
          : ''
        : t('player.companion.chapterIn', { time: formatDurationOrZero(row.until) });

  const render = (i: number) => (
    <Row
      key={i}
      index={i}
      label={labels[i]}
      state={rows[i]?.state ?? null}
      side={sideOf(rows[i])}
      onPress={onPress}
    />
  );

  if (!virtualized) return <View>{labels.map((_, i) => render(i))}</View>;
  return (
    <FlatList
      data={labels}
      // The rows' words follow the playhead; the labels alone never change.
      extraData={`${position}|${current}|${rate}`}
      keyExtractor={(_, i) => String(i)}
      initialScrollIndex={Math.max(0, Math.min(current - 2, labels.length - 1))}
      getItemLayout={(_, index) => ({ length: ROW_H, offset: ROW_H * index, index })}
      onScrollToIndexFailed={() => {}}
      contentContainerStyle={{ paddingBottom: 12 }}
      renderItem={({ index }) => render(index)}
    />
  );
}
