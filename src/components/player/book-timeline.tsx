import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

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

import {
  chapterIndexAt,
  maxSegmentsFor,
  pinFractions,
  SEGMENT_GAP,
  timelineSegments,
  type TimelineState,
} from './book-timeline-model';
import { stepSegment } from './transport';
import { usePlayingPins } from './use-playing-pins';

const TRACK_H = { full: 30, compact: 14 } as const;
/** The pin head and the room above the track it needs. */
const PIN_HEAD = 16;
const PIN_ROOM = PIN_HEAD + 4;
/** The playhead: 3 wide, 4 past the track at each end, with a 3-point halo. */
const HEAD_W = 3;
const HEAD_OVER = 4;
const HALO = 3;

const SEGMENT_CLASS: Record<TimelineState, string> = {
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
  /** `full`: 30-point track, pins, axis. `compact`: 14-point track only. */
  variant?: 'full' | 'compact';
  /** Show the pins (default: the full variant only). */
  pins?: boolean;
  /** Seek to a whole-book position (a tap, a drag's release). Without it the timeline is
   * a picture (`role="image"`), not a control. */
  onSeek?: (bookPosition: number) => void;
  /** Increment/decrement and the web arrow keys: next/previous chapter. Defaults to the
   * neighbouring chapter starts through `onSeek`. */
  onStep?: (direction: 1 | -1) => void;
  className?: string;
};

/**
 * The whole-book timeline (STYLEGUIDE section 8): one segment per chapter (flex =
 * length, 2-point gaps), past chapters in ink, the current one pink with its heard part
 * solid, a pink playhead; bookmark pins (ink) and note pins (community) on stems above;
 * the full variant adds the axis "0:00 · 38% · 17:26:50 · 46:12:00". On the web a hover
 * names the chapter and the time. A tap or drag seeks (a jump, so the Undo chip offers
 * the way back by itself). Accessible as an adjustable "Whole-book timeline" whose steps
 * are chapters. Chapters too narrow to see merge with their neighbours by the measured
 * width.
 */
export function BookTimeline({
  starts,
  total,
  position,
  titles,
  bookmarks,
  notes,
  variant = 'full',
  pins = variant === 'full',
  onSeek,
  onStep,
  className,
}: BookTimelineProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const interactive = !!onSeek && total > 0;
  const at = Math.min(Math.max(0, position), Math.max(0, total));

  const segments = useMemo(
    () => timelineSegments(starts, total, at, maxSegmentsFor(width)),
    [starts, total, at, width],
  );
  const percent = percentHeard(at, total, false);
  const nameAt = (seconds: number) => {
    const index = chapterIndexAt(starts, seconds);
    const title = titles?.[index];
    return starts.length > 0 ? chapterLabel({ title: title ?? '', index }, t) : '';
  };

  const {
    gesture,
    width: widthSv,
    posFrac,
    dragFrac,
    dragging,
    controlProps,
  } = useSliderControl({
    value: at,
    max: Math.max(0, total),
    step: total / 100,
    onStep:
      onStep ??
      ((dir) => {
        const list = starts.length > 0 ? starts : [0];
        const index = chapterIndexAt(list, at);
        const target =
          dir === 1 ? list[index + 1] : at - list[index] > 3 ? list[index] : list[index - 1];
        if (target !== undefined) onSeek?.(target);
      }),
    onValueCommit: (v) => onSeek?.(v),
    onPreview: setScrub,
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
    disabled: !interactive,
  });

  const headStyle = useAnimatedStyle(() => {
    const f = dragging.get() ? dragFrac.get() : posFrac.get();
    return { transform: [{ translateX: f * widthSv.get() - HEAD_W / 2 - HALO }] };
  });

  if (!(total > 0)) return null;

  const trackH = TRACK_H[variant];
  const top = pins ? PIN_ROOM : variant === 'full' ? 8 : 4;
  const onLayout = (e: LayoutChangeEvent) => {
    controlProps.onLayout(e);
    setWidth(e.nativeEvent.layout.width);
  };
  const hoverProps =
    Platform.OS === 'web' && interactive
      ? {
          onPointerMove: (e: { nativeEvent: { clientX: number }; currentTarget: unknown }) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect?.();
            if (!rect || rect.width <= 0) return;
            setHover(Math.max(0, Math.min(1, (e.nativeEvent.clientX - rect.left) / rect.width)));
          },
          onPointerLeave: () => setHover(null),
        }
      : {};
  const tipSeconds = scrub ?? (hover !== null ? hover * total : null);

  const pinViews = pins ? (
    <>
      {pinFractions(bookmarks ?? [], total).map((f, i) => (
        <Pin key={`b${i}`} at={f} kind="bookmark" stem={top - PIN_HEAD + trackH} />
      ))}
      {pinFractions(notes ?? [], total).map((f, i) => (
        <Pin key={`n${i}`} at={f} kind="note" stem={top - PIN_HEAD + trackH} />
      ))}
    </>
  ) : null;

  const track = (
    <View style={{ height: top + trackH + HEAD_OVER }}>
      {pinViews}
      <View
        className="absolute left-0 right-0 flex-row"
        style={{ top, height: trackH, gap: SEGMENT_GAP }}
      >
        {segments.map((s) => (
          <View
            key={s.first}
            testID={`timeline-segment-${s.state}`}
            className={cn('h-full overflow-hidden rounded-[3px]', SEGMENT_CLASS[s.state])}
            style={{ flexGrow: s.weight, flexBasis: 0 }}
          >
            {s.state === 'current' && s.played > 0 ? (
              <View
                className="h-full rounded-[3px] bg-brand"
                style={{ width: `${s.played * 100}%` }}
              />
            ) : null}
          </View>
        ))}
      </View>
      <Animated.View
        pointerEvents="none"
        className="items-center justify-center rounded-full bg-brand/25"
        style={[
          {
            position: 'absolute',
            left: 0,
            top: top - HEAD_OVER - HALO,
            width: HEAD_W + HALO * 2,
            height: trackH + HEAD_OVER * 2 + HALO * 2,
          },
          headStyle,
        ]}
      >
        <View className="flex-1 self-stretch rounded-full bg-brand" style={{ margin: HALO }} />
      </Animated.View>
      {tipSeconds !== null && width > 0 ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            bottom: trackH + HEAD_OVER + 6,
            left: Math.max(60, Math.min(width - 60, (tipSeconds / total) * width)),
            width: 0,
            alignItems: 'center',
          }}
        >
          <View className="rounded-control bg-primary px-2.5 py-1.5 shadow-overlay">
            <Text
              className="font-sans text-xs text-primary-foreground"
              style={tabularNums}
              numberOfLines={1}
            >
              {[nameAt(tipSeconds), formatClock(tipSeconds)].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  return (
    <View className={className}>
      {interactive ? (
        <GestureDetector gesture={gesture}>
          <View
            {...controlProps}
            {...hoverProps}
            onLayout={onLayout}
            className={cn(
              Platform.select({ web: `cursor-pointer rounded-md ${FOCUS_RING_CLASS}` }),
            )}
          >
            {track}
          </View>
        </GestureDetector>
      ) : (
        <View
          onLayout={onLayout}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`${t('player.timeline.label')}, ${t('player.timeline.value', {
            percent,
            position: formatClock(at),
            total: formatClock(total),
          })}`}
        >
          {track}
        </View>
      )}
      {variant === 'full' ? (
        <View className="mt-1 flex-row justify-between">
          {[
            formatClock(0),
            t('player.timeline.axis', { percent, position: formatClock(at) }),
            formatClock(total),
          ].map((label, i) => (
            <Text
              key={i}
              className="font-sans text-[11px] text-subtle-foreground"
              style={tabularNums}
            >
              {label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** How finely the bound timeline follows the playhead: about a pixel of a wide timeline,
 * at least a second. */
const positionStep = (total: number) => Math.max(1, total / 2000);

/**
 * The whole-book timeline of the PLAYING book: its chapters, place, bookmarks and notes,
 * seeking through the store (a jump: the Undo chip follows by itself) and stepping by
 * chapter (`stepSegment`, the transport's own previous/next). Renders nothing with no
 * book or a book without a whole-book timeline (per-file books).
 */
export function PlayerBookTimeline({
  variant = 'compact',
  pins,
  className,
}: {
  variant?: 'full' | 'compact';
  pins?: boolean;
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
  const bookPins = usePlayingPins();
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
      bookmarks={bookPins.bookmarks}
      notes={bookPins.notes}
      variant={variant}
      pins={pins}
      onSeek={(p) => void seekBook(p)}
      onStep={(dir) => stepSegment(usePlayer.getState(), dir)}
      className={className}
    />
  );
}
