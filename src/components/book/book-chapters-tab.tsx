import type { TFunction } from 'i18next';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { SourceLine } from '@/components/library/source-line';
import { BookTimeline } from '@/components/player/book-timeline';
import { timelinePosition } from '@/components/player/book-timeline-model';
import {
  nextSegmentStart,
  previousSegmentStart,
  scrubTarget,
  stepSegment,
} from '@/components/player/transport';
import type { BookPins } from '@/components/player/use-playing-pins';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/notice';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { formatClock, formatDuration } from '@/lib/format';
import { percentHeard } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  type ChapterList,
  type Jump,
  type ListRow,
  rowAt,
  timelineStarts,
} from './book-page-model';

export type BookChaptersTabProps = {
  list: ChapterList;
  /** The book's length, seconds (0: unknown, no timeline). */
  total: number;
  /** The listener's place, whole-book seconds (live while loaded, else saved). */
  position: number;
  /** The row the listener is in (`rowAt`), or -1 before the start. */
  current: number;
  finished: boolean;
  /** This book is the one in the player: the timeline follows and seeks the player. */
  loaded: boolean;
  pins: BookPins;
  /** Room for the start-time column (tablet and desktop). */
  roomy: boolean;
  /** The part length, seconds (the parts notice says it). */
  interval: number;
  /** The chapters are a community recording's list fitted onto this audio
   * (`chapters_source`), not the files' own: a quiet line under the rows says so. */
  fromCommunity: boolean;
  onJump: (jump: Jump) => void;
};

/**
 * The Chapters tab (the prototype's `ChaptersTab`): "The whole book" card, a whole-book
 * timeline with the bookmark and note pins for ANY book (the player's own `BookTimeline`;
 * a tap on a book that isn't playing starts it there), then the rows: the current one
 * marked, the ones behind ticked, a bookmark glyph on a chapter holding one, the start
 * time on wide layouts. A chapterless file lists the player's parts, with a notice
 * saying why; community chapters end with a line saying where they came from.
 */
export function BookChaptersTab({
  list,
  total,
  position,
  current: currentRow,
  finished,
  loaded,
  pins,
  roomy,
  interval,
  fromCommunity,
  onJump,
}: BookChaptersTabProps) {
  const { t } = useTranslation();
  const starts = useMemo(() => timelineStarts(list.rows), [list.rows]);
  const labels = useMemo(
    () => list.rows.map((r) => rowLabel(r, list.kind, t)),
    [list.rows, list.kind, t],
  );
  // Every row is behind a finished listener.
  const current = finished ? list.rows.length : currentRow;
  // The rows holding a bookmark (one in the book: never past its end).
  const marked = useMemo(
    () =>
      new Set(
        pins.bookmarks
          .filter((p) => p >= 0 && !(total > 0 && p > total))
          .map((p) => rowAt(list.rows, p)),
      ),
    [list.rows, pins.bookmarks, total],
  );

  return (
    <View className="gap-4">
      {total > 0 ? (
        <WholeBook
          starts={starts}
          titles={labels}
          total={total}
          savedPosition={finished ? total : position}
          finished={finished}
          loaded={loaded}
          pins={pins}
          onJump={onJump}
        />
      ) : null}
      {list.kind === 'parts' ? (
        <Notice
          icon="circle-info"
          tone="info"
          title={t('book.chapters.partsTitle')}
          body={t('book.chapters.partsBody', { minutes: Math.round(interval / 60) })}
        />
      ) : null}
      <View accessibilityRole="list">
        {list.rows.map((r, i) => (
          <Row
            key={r.key}
            row={r}
            label={labels[i]}
            state={r.index < current ? 'past' : r.index === current ? 'current' : 'ahead'}
            bookmark={marked.has(r.index)}
            roomy={roomy}
            onJump={onJump}
          />
        ))}
      </View>
      {fromCommunity ? (
        <SourceLine
          testID="book-chapters-community"
          label={t('book.chapters.community')}
          className="px-2.5"
        />
      ) : null}
    </View>
  );
}

/** A row's words: the chapter's title (prettified), "Part 3", or the file's name. */
function rowLabel(row: ListRow, kind: ChapterList['kind'], t: TFunction): string {
  if (kind === 'parts') return t('book.chapters.part', { number: row.index + 1 });
  if (kind === 'files') return prettifyChapterTitle(row.title) || row.title;
  return chapterLabel({ title: row.title, index: row.index }, t);
}

/**
 * "The whole book": the timeline with its legend and axis. The playing book's place
 * follows the player (stepped like the full player's, `timelinePosition`) and a tap or
 * drag seeks it; any other book draws its saved place, and a tap starts it there.
 */
function WholeBook({
  starts,
  titles,
  total,
  savedPosition,
  finished,
  loaded,
  pins,
  onJump,
}: {
  starts: number[];
  titles: string[];
  total: number;
  savedPosition: number;
  finished: boolean;
  loaded: boolean;
  pins: BookPins;
  onJump: (jump: Jump) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const live = usePlayer((s) =>
    loaded ? timelinePosition(selectBookPosition(s), total, starts) : -1,
  );
  const seekBook = usePlayer((s) => s.seekBook);
  const position = live >= 0 ? live : savedPosition;
  const onSeek = (p: number) => {
    const at = scrubTarget(p, total);
    if (loaded) void seekBook(at);
    else onJump({ position: at });
  };
  const onStep = (dir: 1 | -1) => {
    if (loaded) return stepSegment(usePlayer.getState(), dir);
    // Not playing: the chapter after the saved place (none: from the place itself), or the
    // start of the one it is in (the one before, within its first seconds), as the
    // player's own previous and next.
    onJump({
      position:
        dir === 1
          ? (nextSegmentStart(starts, position) ?? position)
          : previousSegmentStart(starts, position),
    });
  };
  return (
    <Card testID="book-whole-timeline" className="gap-4 p-5">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text variant="title">{t('book.chapters.wholeBook')}</Text>
        <View className="flex-row items-center gap-3">
          <View className="flex-row items-center gap-1">
            <Icon name="bookmark" size={12} color={themed.mutedForeground} />
            <Text variant="caption">{t('book.chapters.bookmarks')}</Text>
          </View>
          <View className="flex-row items-center gap-1">
            <Icon name="notes" size={12} color={themed.community} />
            <Text variant="caption" className="text-community">
              {t('book.chapters.notes')}
            </Text>
          </View>
        </View>
      </View>
      <View>
        <BookTimeline
          starts={starts}
          total={total}
          position={position}
          titles={titles}
          bookmarks={pins.bookmarks}
          notes={pins.notes}
          onSeek={onSeek}
          onStep={onStep}
        />
        <View className="mt-1.5 flex-row justify-between">
          <Text variant="caption" className="text-subtle-foreground" style={tabularNums}>
            {formatClock(0)}
          </Text>
          <Text variant="caption" className="text-subtle-foreground" style={tabularNums}>
            {`${percentHeard(position, total, finished)}% · ${formatClock(position)}`}
          </Text>
          <Text variant="caption" className="text-subtle-foreground" style={tabularNums}>
            {formatClock(total)}
          </Text>
        </View>
      </View>
    </Card>
  );
}

type RowState = 'past' | 'current' | 'ahead';

/** One chapter, part or file: its number, title (with a bookmark glyph when one is in
 * it), the start time (wide), and a tick once heard or its length. Memoised on its few
 * values, so a moving place redraws only the rows that change. */
const Row = memo(function Row({
  row,
  label,
  state,
  bookmark,
  roomy,
  onJump,
}: {
  row: ListRow;
  label: string;
  state: RowState;
  bookmark: boolean;
  roomy: boolean;
  onJump: (jump: Jump) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const current = state === 'current';
  const past = state === 'past';
  const length = formatDuration(row.length);
  const hasStart = Number.isFinite(row.start);
  const a11y = [
    label,
    current ? t('book.chapters.here') : past ? t('book.chapters.heard') : '',
    bookmark ? t('book.chapters.hasBookmark') : '',
    hasStart ? t('book.chapters.startsAt', { time: formatClock(row.start) }) : '',
    length,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <AnimatedPressable
      onPress={() => onJump(row.jump)}
      accessibilityRole="button"
      accessibilityState={{ selected: current }}
      accessibilityLabel={a11y}
      className={cn(
        'min-h-[44px] flex-row items-center gap-3 rounded-control px-2.5 py-2',
        current ? 'bg-accent' : 'active:bg-accent',
        Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
      )}
    >
      <View className="w-8">
        {current ? (
          <Icon name="play" size={11} color={themed.foreground} />
        ) : (
          <Text className="font-sans-semibold text-xs text-subtle-foreground" style={tabularNums}>
            {row.index + 1}
          </Text>
        )}
      </View>
      <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
        <Text
          numberOfLines={1}
          className={cn(
            'shrink text-sm',
            current ? 'font-sans-bold text-foreground' : past ? 'text-muted-foreground' : '',
          )}
        >
          {label}
        </Text>
        {bookmark ? <Icon name="bookmark" size={12} color={themed.mutedForeground} /> : null}
      </View>
      {roomy && hasStart ? (
        <Text variant="caption" className="w-20 text-right" style={tabularNums}>
          {formatClock(row.start)}
        </Text>
      ) : null}
      <View className="w-16 items-end">
        {past ? (
          <Icon name="check" size={13} color={themed.subtleForeground} />
        ) : length ? (
          <Text variant="caption" style={tabularNums}>
            {length}
          </Text>
        ) : null}
      </View>
    </AnimatedPressable>
  );
});
