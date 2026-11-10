import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CastButton } from '@/cast/cast-button';
import { BookCover } from '@/components/library/book-cover';
import { BookProgressLine } from '@/components/player/book-progress';
import { ControlPill, slopTo44 } from '@/components/player/control-pill';
import { useMiniHeading } from '@/components/player/mini-player';
import { usePlaceSync } from '@/components/player/place-sync';
import { usePlayerOnTop, usePlayerSheets } from '@/components/player/player-sheets';
import { addBookmarkHere } from '@/components/player/player-shortcuts';
import { SleepTimerButton } from '@/components/player/sleep-timer-button';
import { TransportControls, transportWidth } from '@/components/player/transport-controls';
import { UNDO_CHIP_HEIGHT, UndoChip, useUndoVisible } from '@/components/player/undo-chip';
import { usePlayingPins } from '@/components/player/use-playing-pins';
import { SEGMENT_LABEL, usePlayingSegment } from '@/components/player/use-playing-segment';
import { usePlayingTimeLeft } from '@/components/player/use-time-left';
import { EpisodeFetchStrip } from '@/components/podcasts/episode-fetch-panel';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Slider } from '@/components/ui/slider';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { UpNextButton } from '@/components/upnext/up-next-button';
import { formatClock, formatSpeed } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useEpisodeFetch } from '@/playback/episode-fetch';
import { selectIsPlaying, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { useChromeEdge } from './shell-metrics';

/** The bar's height above the safe area (STYLEGUIDE "Docked player bar"). */
const DOCK_HEIGHT = 84;
/** The bar's side padding and the gap between its three columns (the same on both sides,
 * so the middle column's centre is the bar's). */
const DOCK_PAD = 16;
const DOCK_GAP = 16;
/** What a side column needs for every action (speed, sleep, bookmark, output, cast, Up
 * next, expand) or for the tablet set (sleep, Up next, expand), with the sleep pill idle. */
const SIDE_ALL = 330;
const SIDE_TABLET = 220;
/** The middle column with the scrubber row: never narrower (a usable scrubber), never
 * wider (a long track on a wide window is a long way to drag). */
const CENTRE_MIN = 300;
const CENTRE_MAX = 560;
/** The space between the floating Undo chip and the bar, and the band it floats in. */
const CHIP_GAP = 8;
const CHIP_BAND = UNDO_CHIP_HEIGHT + CHIP_GAP;

/**
 * What the dock shows at its MEASURED width (the bar spans the window under the page and
 * the desktop drawer; a tablet, a split view or a narrow browser window is less), and how
 * wide its middle column is: from 1024 every action (speed, bookmark, output); below it
 * the tablet set, whose hidden actions are all in the full player; below 800 the chapter
 * scrubber row goes too (the transport alone is the middle column).
 *
 * Three columns (fe#244): the book and the actions are equal side columns and the
 * transport sits between them, so it is centred on the bar whatever the title, the
 * actions or the sleep countdown. Only the width decides any of it: the Undo chip floats
 * above the bar (`DockedPlayer`), so a jump never moves or resizes the scrubber under the
 * pointer that made it.
 */
export function dockLayout(width: number): {
  allActions: boolean;
  scrubber: boolean;
  centre: number;
} {
  const allActions = width >= 1024;
  const scrubber = width >= 800;
  const inner = width - 2 * DOCK_PAD - 2 * DOCK_GAP;
  const side = allActions ? SIDE_ALL : SIDE_TABLET;
  const centre = scrubber
    ? Math.min(CENTRE_MAX, Math.max(CENTRE_MIN, inner - 2 * side))
    : transportWidth('sm');
  return { allActions, scrubber, centre };
}

/** The chapter scrubber row: elapsed in the chapter, a thin scrubber with the chapter's
 * bookmark ticks (`bookmarks`: the playing book's, whole-book seconds), and the time
 * left in the whole book at the listener's speed. A leaf that moves in whole seconds
 * (the clock's resolution), so it re-renders about once a second, not per engine tick. */
function ChapterScrubber({ bookmarks }: { bookmarks: readonly number[] }) {
  const { t } = useTranslation();
  const left = usePlayingTimeLeft();
  const [scrub, setScrub] = useState<number | null>(null);
  const {
    segment,
    kind,
    elapsed,
    onSeek,
    bookmarks: inSegment,
  } = usePlayingSegment(bookmarks, { wholeSeconds: true, hold: scrub !== null });
  return (
    <View className="-my-2.5 flex-row items-center gap-2.5">
      <Text variant="caption" style={tabularNums} className="min-w-[44px] text-right">
        {formatClock(scrub ?? elapsed)}
      </Text>
      <View className="min-w-0 flex-1">
        <Slider
          value={elapsed}
          max={Math.max(0, segment.length)}
          step={15}
          tone="ink"
          onValueCommit={onSeek}
          onPreview={setScrub}
          accessibilityLabel={t(SEGMENT_LABEL[kind])}
          valueText={(v) =>
            t('player.seek.value', {
              position: formatClock(v),
              duration: formatClock(segment.length),
            })
          }
        />
        {/* The chapter's bookmarks, ticks over the track (decoration: the full player's
            bookmark list is the accessible way to them). */}
        {inSegment.map((p, i) => (
          <View
            key={`${i}-${p}`}
            testID="dock-bookmark-tick"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="absolute top-1/2 -mt-[5.5px] h-[11px] w-0.5 rounded-[1px] bg-foreground/55"
            style={{ left: `${(p / Math.max(1, segment.length)) * 100}%`, marginLeft: -1 }}
          />
        ))}
      </View>
      <Text variant="caption" style={tabularNums} numberOfLines={1}>
        {left}
      </Text>
    </View>
  );
}

/** Where the place lives (`usePlaceSync`, the full player's status line says the same).
 * Nothing for a book whose server was removed (a download playing on). */
function SyncState({ connectionId, playing }: { connectionId: string; playing: boolean }) {
  const themed = useThemeColors();
  const sync = usePlaceSync(connectionId, playing);
  if (!sync) return null;
  return (
    <View testID="dock-sync-state" className="flex-row items-center gap-[5px]">
      <Icon name={sync.icon} size={12} color={themed.subtleForeground} />
      <Text variant="caption" className="text-[11px] text-subtle-foreground" numberOfLines={1}>
        {sync.text}
      </Text>
    </View>
  );
}

/** The dock's right-hand actions: 36 px round pills like the sleep pill beside them
 * (`SleepTimerButton`), with a 44 pt target (`DOCK_SLOP`: 4 on the web, more on native,
 * where a rem is 14 pt). */
const DOCK_PILL = 'h-9 min-w-9 flex-row gap-1.5 px-2.5';
const DOCK_SLOP = slopTo44(2.25);

/** The speed pill ("1.25×"), opening the speed sheet. */
function SpeedPill() {
  const { t } = useTranslation();
  const rate = usePlayer((s) => s.rate);
  return (
    <ControlPill
      testID="dock-speed"
      hitSlop={DOCK_SLOP}
      className={DOCK_PILL}
      label={t('shell.dock.speed', { speed: formatSpeed(rate) })}
      onPress={() => usePlayerSheets.getState().openSheet('speed')}
    >
      <Text className="font-sans-bold text-[12.5px] text-foreground" style={tabularNums}>
        {formatSpeed(rate)}
      </Text>
    </ControlPill>
  );
}

/**
 * The docked player bar (84, STYLEGUIDE section 8 "Docked player bar") on tablet and
 * desktop, whenever a book is loaded: a 3 px whole-book progress line along the top; the
 * cover, chapter, book · author and the sync state on the left (tap for the full player);
 * the transport over a chapter scrubber (bookmark ticks, the time left in the book at the
 * listener's speed) centred on the bar; on the right speed, sleep, bookmark, output (where
 * the engine can pick one), Up next and expand. After a jump the Undo chip floats above
 * the bar over the transport. What fits is decided by the bar's measured width
 * (`dockLayout`); everything hidden is in the full player.
 *
 * Speed and sleep open through `usePlayerSheets` (the web's keys open the same sheets),
 * rendered by the shell's one sheet host. Renders a fragment so that host can sit beside
 * the bar in the shell's root column and cover the whole app.
 *
 * While an episode is fetched (`EpisodeFetchStrip`, Bridge Phase 2d-1) its strip sits on
 * top of the bar, over the book that plays on meanwhile, or is the whole bar when nothing
 * is loaded.
 */
export function DockedPlayer() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const insets = useSafeAreaInsets();
  const desktop = useLayout() === 'desktop';
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const { heading, isChapter } = useMiniHeading();
  const isPlaying = usePlayer(selectIsPlaying);
  const canRoutePick = usePlayer((s) => s.canRoutePick);
  const showRoutePicker = usePlayer((s) => s.showRoutePicker);
  const undo = useUndoVisible();
  const onTop = usePlayerOnTop();
  // The playing book's bookmarks, once for the bar.
  const pins = usePlayingPins();
  // The bar sits on the window's bottom edge, so its height is its top edge (published
  // for the root toasts and the sleep grace card), and the Undo chip's band above it
  // while the chip shows, so they clear it. Its width picks what fits.
  const [size, setSize] = useState<{ width: number; height: number }>();
  const fetching = useEpisodeFetch((s) => s.pending !== null);
  const chipBand = nowPlaying && undo ? CHIP_BAND : 0;
  useChromeEdge('dock', (nowPlaying || fetching) && size ? size.height + chipBand : undefined);
  // Nothing under the full player: the bar is hidden there, and its per-tick leaves
  // would only redraw behind it.
  if (onTop || (!nowPlaying && !fetching)) return null;
  const onLayout = (e: { nativeEvent: { layout: { width: number; height: number } } }) =>
    setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  const edges = {
    paddingBottom: insets.bottom,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  };
  if (!nowPlaying) {
    return (
      <View
        testID="shell-docked-player"
        accessibilityLabel={t('shell.dock.label')}
        onLayout={onLayout}
        style={edges}
        className="border-t border-border bg-card"
      >
        <EpisodeFetchStrip className="pl-3.5 pr-4" />
      </View>
    );
  }

  // The row's width (the bar's, inside its side insets); before the first layout, the
  // form factor's guess.
  const { allActions, scrubber, centre } = dockLayout(
    size ? size.width - insets.left - insets.right : desktop ? 1280 : 800,
  );
  const { queue, title, author } = nowPlaying;
  // Under a chapter heading the book and its author; when the heading is already the
  // title (a chapterless book, an episode) only the author or show, never the title twice.
  const bookLine = [isChapter && title, author].filter(Boolean).join(' · ');
  const openPlayer = () => router.push('/player');

  return (
    <>
      <View
        testID="shell-docked-player"
        accessibilityLabel={t('shell.dock.label')}
        onLayout={onLayout}
        style={edges}
        className="border-t border-border bg-card"
      >
        <EpisodeFetchStrip className="border-b border-border pl-3.5 pr-4" />
        {/* The 3px whole-book progress line along the bar's top edge (a leaf). */}
        <BookProgressLine total={queue.total} className="absolute left-0 right-0 top-0 h-[3px]" />
        {/* The Undo chip floats just above the bar, centred over the transport: in the bar
            it took room from the scrubber, which then moved under the pointer that made
            the jump (fe#244). Nothing in the bar lays out around it. */}
        <View
          testID="dock-undo"
          pointerEvents="box-none"
          style={{ bottom: '100%', marginBottom: CHIP_GAP, zIndex: 20 }}
          className="absolute left-0 right-0 items-center"
        >
          <UndoChip />
        </View>
        <View
          testID="dock-row"
          style={{ height: DOCK_HEIGHT, paddingHorizontal: DOCK_PAD, gap: DOCK_GAP }}
          className="flex-row items-center"
        >
          <AnimatedPressable
            testID="dock-book"
            onPress={openPlayer}
            accessibilityRole="button"
            accessibilityLabel={t('shell.openPlayer', { title })}
            className={cn(
              // A side column: as wide as the actions' (both flex from nothing).
              'min-w-0 flex-1 basis-0 flex-row items-center gap-3 rounded-menu p-1.5 active:bg-accent',
              Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
            )}
          >
            <BookCover
              connectionId={nowPlaying.connectionId}
              libraryId={nowPlaying.libraryId}
              path={nowPlaying.path}
              width={desktop ? 56 : 48}
              title={title}
            />
            <View className="min-w-0 flex-1">
              <Text variant="label" numberOfLines={1}>
                {heading}
              </Text>
              {bookLine ? (
                <Text variant="caption" numberOfLines={1}>
                  {bookLine}
                </Text>
              ) : null}
              <SyncState connectionId={nowPlaying.connectionId} playing={isPlaying} />
            </View>
          </AnimatedPressable>

          <View testID="dock-centre" style={{ width: centre }} className="shrink-0 justify-center">
            <TransportControls size="sm" />
            {scrubber ? <ChapterScrubber bookmarks={pins.bookmarks} /> : null}
          </View>

          <View
            testID="dock-actions"
            // The other side column, its actions against the bar's end. Its side padding is
            // the book's (`p-1.5`): a flex basis of 0 still counts padding, so unequal
            // padding would make unequal columns and move the transport off the centre.
            className="min-w-0 flex-1 basis-0 flex-row items-center justify-end gap-1 px-1.5"
          >
            {allActions ? <SpeedPill /> : null}
            <View testID="dock-sleep">
              <SleepTimerButton onPress={() => usePlayerSheets.getState().openSheet('sleep')} />
            </View>
            {allActions ? (
              <ControlPill
                testID="dock-bookmark"
                hitSlop={DOCK_SLOP}
                className={DOCK_PILL}
                label={t('player.shortcuts.bookmark')}
                onPress={() => void addBookmarkHere(t)}
              >
                <Icon name="bookmark" size={16} color={themed.foreground} />
              </ControlPill>
            ) : null}
            {allActions && canRoutePick ? (
              <ControlPill
                testID="dock-output"
                hitSlop={DOCK_SLOP}
                className={DOCK_PILL}
                label={t('player.routePicker.label')}
                onPress={() => void showRoutePicker()}
              >
                <Icon name="airplay" size={16} color={themed.foreground} />
              </ControlPill>
            ) : null}
            {allActions ? (
              <CastButton className={DOCK_PILL} hitSlop={DOCK_SLOP} compact testID="dock-cast" />
            ) : null}
            <UpNextButton variant="dock" />
            <ControlPill
              testID="dock-expand"
              hitSlop={DOCK_SLOP}
              className={DOCK_PILL}
              label={t('shell.dock.expand')}
              onPress={openPlayer}
            >
              <Icon name="chevron-up" size={16} color={themed.foreground} />
            </ControlPill>
          </View>
        </View>
      </View>
    </>
  );
}
