import { memo, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FlatList,
  type LayoutChangeEvent,
  Platform,
  useWindowDimensions,
  View,
} from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { formatClock, formatDurationOrZero } from '@/lib/format';
import { isLargeText, scaleCapped, useFontScale } from '@/lib/text-scale';
import { useLatest } from '@/lib/use-latest';
import { cn } from '@/lib/utils';
import { trackIdOf, trackIndexById } from '@/playback/book-queue';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { selectBookPosition, selectCurrentChapter, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { trackLabel } from '../transport';
import { chapterRows, type ChapterRow } from './companion-model';

/** A row's height at the default text size. The list's rows are one height (its
 * `getItemLayout`), so it follows the text scale: `chapterRowHeight`. */
const ROW_H = 52;
/** Past this text scale the rows stop growing (iOS's largest size is 3.12). */
const ROW_MAX_SCALE = 3.2;

/** A chapter row's height at text `scale`: grown with it, so a title of up to two lines
 * fits under large text. */
export function chapterRowHeight(scale: number): number {
  return scaleCapped(ROW_H, scale, ROW_MAX_SCALE);
}

/**
 * The row a virtualized chapter list opens at (`initialScrollIndex`): `want`, when the rows
 * from it on fill a window's height, so the list can scroll that far. Otherwise none: a list
 * too short for it renders from that row and never fills in the rows above it, which stay
 * blank and untappable (FlatList on Android: Part 1 of a four-file book opened on Part 4).
 * The list then opens at its top and scrolls to the row once laid out (`ChaptersPanel`).
 */
export function openingIndex(
  want: number,
  count: number,
  rowHeight: number,
  windowHeight: number,
): number | undefined {
  return want > 0 && (count - want) * rowHeight >= windowHeight ? want : undefined;
}

/** The list's bottom padding. */
const LIST_PAD_BOTTOM = 12;

type RowProps = {
  index: number;
  label: string;
  state: ChapterRow['state'] | null;
  /** What the right-hand column says ("in 2h 4m", "-12:40"), already formatted. */
  side: string;
  /** The row's height (`chapterRowHeight`). */
  height: number;
  /** The title may take two lines (large text). */
  wrap: boolean;
  /** Stable across ticks (`useLatest`), so it never breaks the memo. */
  onPress: (index: number) => void;
};

/** One chapter: its number (a play glyph on the current one), title, and a tick, the
 * time left in it, or how long until it starts. Memoised on primitives, so a tick only
 * redraws the rows whose words changed (the current one each second, an ahead one when
 * its minute turns). */
const Row = memo(function Row({ index, label, state, side, height, wrap, onPress }: RowProps) {
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
      style={{ height }}
      className={cn(
        'flex-row items-center gap-3 rounded-control px-3',
        current ? 'bg-brand-soft' : 'active:bg-accent',
        Platform.select({
          web: `cursor-pointer ${current ? '' : 'hover:bg-accent'} ${FOCUS_RING_CLASS}`,
        }),
      )}
    >
      {/* A min width: the number's own width wins under large text, never a digit a line. */}
      <View className="min-w-7 items-center">
        {current ? (
          <Icon name="play" size={12} color={themed.brandInk} />
        ) : (
          <Text variant="caption" style={tabularNums} numberOfLines={1}>
            {index + 1}
          </Text>
        )}
      </View>
      <Text
        numberOfLines={wrap ? 2 : 1}
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
  const libraryId = usePlayer((s) => s.nowPlaying?.libraryId ?? 0);
  const title = usePlayer((s) => s.nowPlaying?.title ?? '');
  const total = queue?.total ?? 0;
  const perTrack = total <= 0;
  // Whole seconds: the right-hand column's resolution.
  const position = usePlayer((s) => Math.floor(selectBookPosition(s)));
  const chapterIndex = usePlayer((s) => selectCurrentChapter(s)?.index ?? 0);
  const trackIndex = usePlayer((s) => s.snapshot.trackIndex);
  const rate = usePlayer((s) => s.rate);
  const scale = useFontScale();
  const rowHeight = chapterRowHeight(scale);
  const { height: windowHeight } = useWindowDimensions();
  const list = useRef<FlatList<string>>(null);
  /** The list (this mount of it) once it was first laid out, when one that opened at its top
   * is scrolled to the current row (`openingIndex`): one that mounts again (the panel stayed
   * while its book came and went) is placed again; a later layout of the same one (a
   * rotation, a resized column) never is, wherever the playhead has got to. */
  const placed = useRef<FlatList<string> | null>(null);
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
      // In the chapter's own file: files of unknown length share a start (fe#324).
      if (queue && c) {
        void seekBook(c.book_offset, trackIndexById(queue, trackIdOf(libraryId, c.file_path)));
      }
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
      height={rowHeight}
      wrap={isLargeText(scale)}
      onPress={onPress}
    />
  );

  if (!virtualized) return <View>{labels.map((_, i) => render(i))}</View>;
  const want = Math.max(0, Math.min(current - 2, labels.length - 1));
  const opening = openingIndex(want, labels.length, rowHeight, windowHeight);
  // Opened at its top: scrolled to the row as far as the list goes, once, when first laid out.
  const onLayout = (e: LayoutChangeEvent) => {
    if (!list.current || placed.current === list.current) return;
    placed.current = list.current;
    if (opening !== undefined) return;
    const room = labels.length * rowHeight + LIST_PAD_BOTTOM - e.nativeEvent.layout.height;
    const offset = Math.min(want * rowHeight, Math.max(0, room));
    if (offset > 0) list.current?.scrollToOffset({ offset, animated: false });
  };
  return (
    <FlatList
      ref={list}
      testID="chapters-list"
      data={labels}
      // The rows' words follow the playhead; the labels alone never change.
      extraData={`${position}|${current}|${rate}`}
      keyExtractor={(_, i) => String(i)}
      initialScrollIndex={opening}
      getItemLayout={(_, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
      onScrollToIndexFailed={() => {}}
      onLayout={onLayout}
      contentContainerStyle={{ paddingBottom: LIST_PAD_BOTTOM }}
      renderItem={({ index }) => render(index)}
    />
  );
}
