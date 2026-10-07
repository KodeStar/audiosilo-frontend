import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';

import {
  bookmarkPins,
  chapterIndexAt,
  runState,
  type ScaleState,
} from '@/components/home/now-card-model';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { useSliderControl } from '@/components/ui/use-slider-control';
import { chapterLabel } from '@/lib/chapter-label';
import { formatClock } from '@/lib/format';
import { percentHeard } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { heardIn, SEGMENT_GAP, timelineRuns } from './book-timeline-model';
import { Playhead, ScrubTip, useWebHoverFraction } from './scrub-parts';
import { stepSegment } from './transport';
import type { BookPins } from './use-playing-pins';

const TRACK_H = 14;
/** The track's top without pins. */
const TRACK_TOP = 4;
/** The pin head and the room above the track it needs. */
const PIN_HEAD = 16;
const PIN_ROOM = PIN_HEAD + 4;
/** The playhead: 3 wide, 4 past the track at each end. */
const HEAD_W = 3;
const HEAD_OVER = 4;

const SEGMENT_CLASS: Record<ScaleState, string> = {
  past: 'bg-foreground/35',
  current: 'bg-brand/25',
  ahead: 'bg-muted-foreground/15',
};

/** A pin head (a teardrop pointing down at its place) and its stem. */
function Pin({
  at,
  kind,
  stem,
}: {
  at: number;
  kind: 'bookmark' | 'note';
  /** From the head's foot to the track's foot. */
  stem: number;
}) {
  const themed = useThemeColors();
  return (
    <View
      pointerEvents="none"
      testID={`timeline-${kind}`}
      className="absolute top-0 items-center"
      style={{ left: `${at * 100}%`, width: PIN_HEAD, marginLeft: -PIN_HEAD / 2 }}
    >
      <View
        className={cn(
          'items-center justify-center rounded-full rounded-bl-[2px]',
          kind === 'note' ? 'bg-community' : 'bg-foreground',
        )}
        style={{ width: PIN_HEAD, height: PIN_HEAD, transform: [{ rotate: '-45deg' }] }}
      >
        <View style={{ transform: [{ rotate: '45deg' }] }}>
          <Icon name={kind === 'note' ? 'notes' : 'bookmark'} size={9} color={themed.background} />
        </View>
      </View>
      <View
        className={cn('w-[1.5px]', kind === 'note' ? 'bg-community/40' : 'bg-foreground/35')}
        style={{ height: stem }}
      />
    </View>
  );
}

/** One segment (a chapter, or a run of them), memoised on its few numbers: as the
 * playhead moves only the current one redraws. */
const Segment = memo(function Segment({
  weight,
  state,
  played,
}: {
  weight: number;
  state: ScaleState;
  /** How much of the current segment is heard, 0..1. */
  played: number;
}) {
  return (
    <View
      testID={`timeline-segment-${state}`}
      className={cn('h-full overflow-hidden rounded-[3px]', SEGMENT_CLASS[state])}
      style={{ flexGrow: weight, flexBasis: 0 }}
    >
      {played > 0 ? (
        <View className="h-full rounded-[3px] bg-brand" style={{ width: `${played * 100}%` }} />
      ) : null}
    </View>
  );
});

export type BookTimelineProps = {
  /** Chapter starts, whole-book seconds, ascending (none: the whole book is one). */
  starts: readonly number[];
  /** The book's length, seconds. Nothing renders when it is unknown (<= 0). */
  total: number;
  /** The listener's place, whole-book seconds. */
  position: number;
  /** Chapter titles, by index (the hover tip and value text name the chapter). */
  titles?: readonly string[];
  /** Bookmark positions, whole-book seconds (ink pins). */
  bookmarks?: readonly number[];
  /** Note positions, whole-book seconds (community pins). */
  notes?: readonly number[];
  /** Seek to a whole-book position (a tap, a drag's release). */
  onSeek: (bookPosition: number) => void;
  /** Increment/decrement and the web arrow keys: next/previous chapter. */
  onStep: (direction: 1 | -1) => void;
  /** Whether the scrub (or web hover) tip is showing: it floats over whatever sits just
   * above (the seek bar's times row), which the caller can make way for. */
  onTip?: (showing: boolean) => void;
  className?: string;
};

/**
 * The whole-book timeline (STYLEGUIDE section 8): one segment per chapter (flex =
 * length, 2-point gaps; the Now card's `scaleRuns`), past chapters in ink, the current
 * one pink with its heard part solid, a pink playhead; bookmark pins (ink) and note pins
 * (community) on stems above. On the web a hover names the chapter and the time. A tap
 * or drag seeks (a jump, so the Undo chip offers the way back by itself); a tap on a pin
 * lands on it exactly. Accessible as an adjustable "Whole-book timeline" whose steps are
 * chapters. Chapters too narrow to see merge with their neighbours by the measured
 * width.
 */
export function BookTimeline({
  starts,
  total,
  position,
  titles,
  bookmarks,
  notes,
  onSeek,
  onStep,
  onTip,
  className,
}: BookTimelineProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const known = total > 0;
  const { hover, hoverProps } = useWebHoverFraction(known);
  const at = Math.min(Math.max(0, position), Math.max(0, total));

  // The structure follows the chapters and the width only; the playhead picks the current
  // run and how much of it is heard.
  const runs = useMemo(() => timelineRuns(starts, total, width), [starts, total, width]);
  const chapter = chapterIndexAt(starts, at);
  const pins = useMemo(
    () => ({
      bookmarks: bookmarkPins(bookmarks ?? [], total),
      notes: bookmarkPins(notes ?? [], total),
    }),
    [bookmarks, notes, total],
  );
  const hasPins = pins.bookmarks.length + pins.notes.length > 0;

  const nameAt = (seconds: number) => {
    if (starts.length === 0) return '';
    const index = chapterIndexAt(starts, seconds);
    return chapterLabel({ title: titles?.[index] ?? '', index }, t);
  };
  // A tap within a pin's head lands on its place.
  const snapToPin = (v: number) => {
    if (!(width > 0)) return v;
    const reach = (PIN_HEAD / 2 / width) * total;
    let best = v;
    let gap = reach;
    for (const p of [...(bookmarks ?? []), ...(notes ?? [])]) {
      if (Math.abs(p - v) <= gap) {
        best = p;
        gap = Math.abs(p - v);
      }
    }
    return best;
  };

  const control = useSliderControl({
    value: at,
    max: Math.max(0, total),
    step: total / 100,
    onStep,
    onValueCommit: onSeek,
    onPreview: setScrub,
    snapTap: snapToPin,
    accessibilityLabel: t('player.timeline.label'),
    valueText: (v) =>
      [
        nameAt(v),
        t('player.timeline.value', {
          percent: percentHeard(v, total, false),
          position: formatClock(v),
          total: formatClock(total),
        }),
      ]
        .filter(Boolean)
        .join(', '),
    disabled: !known,
  });

  if (!known) return null;

  const top = hasPins ? PIN_ROOM : TRACK_TOP;
  const onLayout = (e: LayoutChangeEvent) => {
    control.controlProps.onLayout(e);
    setWidth(e.nativeEvent.layout.width);
  };
  const tipSeconds = scrub ?? (hover !== null ? hover * total : null);
  const stem = top - PIN_HEAD + TRACK_H;

  return (
    <View className={className}>
      <GestureDetector gesture={control.gesture}>
        <View
          {...control.controlProps}
          {...hoverProps}
          onLayout={onLayout}
          className={cn(Platform.select({ web: `cursor-pointer rounded-md ${FOCUS_RING_CLASS}` }))}
        >
          <View style={{ height: top + TRACK_H + HEAD_OVER }}>
            {pins.bookmarks.map((f, i) => (
              <Pin key={`b${i}`} at={f} kind="bookmark" stem={stem} />
            ))}
            {pins.notes.map((f, i) => (
              <Pin key={`n${i}`} at={f} kind="note" stem={stem} />
            ))}
            <View
              className="absolute left-0 right-0 flex-row"
              style={{ top, height: TRACK_H, gap: SEGMENT_GAP }}
            >
              {runs.map((r) => {
                const state = runState(r, chapter);
                const played = state === 'current' ? heardIn(r, at) : 0;
                return <Segment key={r.first} weight={r.weight} state={state} played={played} />;
              })}
            </View>
            <Playhead
              track={control.track}
              width={HEAD_W}
              height={TRACK_H + HEAD_OVER * 2}
              top={top - HEAD_OVER}
            />
            {tipSeconds !== null && width > 0 ? (
              <ScrubTip
                x={(tipSeconds / total) * width}
                width={width}
                edge={60}
                bottom={TRACK_H + HEAD_OVER + 6}
                onTip={onTip}
              >
                <Text
                  className="font-sans text-xs text-primary-foreground"
                  style={tabularNums}
                  numberOfLines={1}
                >
                  {[nameAt(tipSeconds), formatClock(tipSeconds)].filter(Boolean).join(' · ')}
                </Text>
              </ScrubTip>
            ) : null}
          </View>
        </View>
      </GestureDetector>
    </View>
  );
}

/** How finely the bound timeline follows the playhead: about a pixel of a wide timeline,
 * at least a second. */
const positionStep = (total: number) => Math.max(1, total / 2000);

/**
 * The whole-book timeline of the PLAYING book: its chapters, place, and the pins the
 * caller fetched once (`usePlayingPins`), seeking through the store (a jump: the Undo chip
 * follows by itself) and stepping by chapter (`stepSegment`, the transport's own
 * previous/next). Renders nothing with no book or a book without a whole-book timeline
 * (per-file books).
 */
export function PlayerBookTimeline({
  pins,
  onTip,
  className,
}: {
  pins?: BookPins;
  onTip?: (showing: boolean) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const queue = usePlayer((s) => s.nowPlaying?.queue ?? null);
  const total = queue?.total ?? 0;
  const position = usePlayer((s) => {
    const step = positionStep(total);
    return Math.floor(selectBookPosition(s) / step) * step;
  });
  const seekBook = usePlayer((s) => s.seekBook);
  const chapters = queue?.chapters;
  const { starts, titles } = useMemo(
    () => ({
      starts: (chapters ?? []).map((c) => c.book_offset),
      titles: (chapters ?? []).map((c) => chapterLabel(c, t)),
    }),
    [chapters, t],
  );
  if (!queue || total <= 0) return null;
  return (
    <BookTimeline
      starts={starts}
      total={total}
      position={position}
      titles={titles}
      bookmarks={pins?.bookmarks}
      notes={pins?.notes}
      onSeek={(p) => void seekBook(p)}
      onStep={(dir) => stepSegment(usePlayer.getState(), dir)}
      onTip={onTip}
      className={className}
    />
  );
}
