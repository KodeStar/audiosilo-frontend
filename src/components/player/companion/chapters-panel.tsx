import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  FlatList,
  type LayoutChangeEvent,
  Platform,
  useWindowDimensions,
  View,
  type ViewInstance,
} from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { formatClock, formatDurationOrZero } from '@/lib/format';
import { openingIndex, openingOffset } from '@/lib/list-opening';
import { quietly } from '@/lib/quietly';
import { isLargeText, scaleCapped, useFontScale } from '@/lib/text-scale';
import { useLatest } from '@/lib/use-latest';
import { cn } from '@/lib/utils';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { selectBookPosition, selectCurrentChapter, usePlayer } from '@/playback/store';
import { wholeSecondsLeft } from '@/playback/time-left';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { type PageScroll, usePageScroll } from '../page-scroll';
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

/** The list's bottom padding. */
const LIST_PAD_BOTTOM = 12;

/** Inline, a list of up to this many rows draws them all; a longer one draws only the rows
 * near the visible part of the page (`PageRows`). */
const INLINE_ALL_UP_TO = 100;
/** The drawn rows move in steps of this many, so a scroll redraws the list once a step. */
const INLINE_STEP = 20;

/**
 * The rows `[first, last)` an inline list draws: those within one page height above or
 * below the visible part, in `INLINE_STEP` steps. `top` is the list's top in the page's
 * content (null until measured: then the rows from the top, as a list just below the
 * controls shows first), `y` how far the page is scrolled and `height` its visible height.
 */
export function inlineRows(
  count: number,
  rowHeight: number,
  top: number | null,
  y: number,
  height: number,
): [number, number] {
  const clamp = (n: number) => Math.min(count, Math.max(0, n));
  // Not measured yet: as if the list started at the top of the visible part.
  const at = y - (top ?? y);
  const first = Math.floor((at - height) / rowHeight / INLINE_STEP) * INLINE_STEP;
  const last = Math.ceil((at + 2 * height) / rowHeight / INLINE_STEP) * INLINE_STEP;
  return [clamp(first), clamp(last)];
}

/**
 * A long chapter list inline in the player's page (the tablet's companion): every row's
 * room is held, but only the rows near the visible part of the page are drawn
 * (`inlineRows`), so a book of a thousand chapters scrolls as one of ten. The page scrolls
 * the list (a nested virtual list would never know its viewport), so the list follows the
 * page's scroll (`usePageScroll`) and measures where it sits in it. A screen reader or a
 * keyboard moving past the drawn rows scrolls the page, which draws the next ones.
 */
function PageRows({
  page,
  count,
  rowHeight,
  render,
}: {
  page: PageScroll;
  count: number;
  rowHeight: number;
  render: (index: number) => ReactNode;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const self = useRef<ViewInstance>(null);
  const [top, setTop] = useState<number | null>(null);
  // Both measured in the same pass, so a scroll moves them alike and the difference holds.
  const measure = useCallback(() => {
    const view = self.current;
    const origin = page.origin();
    if (!view || !origin) return;
    let listY: number | undefined;
    let originY: number | undefined;
    const done = () => {
      if (listY !== undefined && originY !== undefined) setTop(listY - originY);
    };
    origin.measureInWindow((_x, y) => {
      originY = y;
      done();
    });
    view.measureInWindow((_x, y) => {
      listY = y;
      done();
    });
  }, [page]);
  const layoutOf = () => page.get().layout;
  const layout = useSyncExternalStore(page.subscribe, layoutOf, layoutOf);
  useEffect(() => measure(), [layout, measure]);
  const rows = () => {
    const { y, height } = page.get();
    return inlineRows(count, rowHeight, top, y, height || windowHeight);
  };
  // Each a number, so a scroll within a step re-renders nothing.
  const firstOf = () => rows()[0];
  const lastOf = () => rows()[1];
  const first = useSyncExternalStore(page.subscribe, firstOf, firstOf);
  const last = useSyncExternalStore(page.subscribe, lastOf, lastOf);
  const drawn: ReactNode[] = [];
  for (let i = first; i < last; i++) drawn.push(render(i));
  return (
    <View ref={self} testID="chapters-page-rows" onLayout={measure}>
      {first > 0 ? <View style={{ height: first * rowHeight }} /> : null}
      {drawn}
      {last < count ? <View style={{ height: (count - last) * rowHeight }} /> : null}
    </View>
  );
}

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
 * page it is a plain list, drawn only near the visible part of the page when it is long
 * (`PageRows`).
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
  const scale = useFontScale();
  const rowHeight = chapterRowHeight(scale);
  const { height: windowHeight } = useWindowDimensions();
  const page = usePageScroll();
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
    if (perTrack) quietly(goToTrack(i));
    else {
      const c = queue?.chapters[i];
      // In the chapter's own file: files of unknown length share a start (fe#324).
      if (c) {
        quietly(seekBook(c.book_offset, { path: c.file_path, pos: c.start }));
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
  const sideOf = (row: ChapterRow | null): string => {
    if (!row || row.state === 'past') return '';
    if (row.state === 'ahead') {
      return t('player.companion.chapterIn', { time: formatDurationOrZero(row.until) });
    }
    // Rounded as the seek row's countdown and its words are (`wholeSecondsLeft`, fe#197).
    const left = wholeSecondsLeft(row.left);
    return left > 0 ? `-${formatClock(left)}` : '';
  };

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

  if (!virtualized) {
    if (page && labels.length > INLINE_ALL_UP_TO) {
      return <PageRows page={page} count={labels.length} rowHeight={rowHeight} render={render} />;
    }
    return <View>{labels.map((_, i) => render(i))}</View>;
  }
  const want = Math.max(0, Math.min(current - 2, labels.length - 1));
  const opening = openingIndex(want, labels.length, rowHeight, windowHeight);
  // Opened at its top: scrolled to the row as far as the list goes, once, when first laid out.
  const onLayout = (e: LayoutChangeEvent) => {
    if (!list.current || placed.current === list.current) return;
    placed.current = list.current;
    if (opening !== undefined) return;
    const offset = openingOffset(
      want,
      labels.length,
      rowHeight,
      e.nativeEvent.layout.height,
      LIST_PAD_BOTTOM,
    );
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
