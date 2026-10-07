import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BookCover } from '@/components/library/book-cover';
import { BookProgressLine } from '@/components/player/book-progress';
import { ControlPill } from '@/components/player/control-pill';
import { useMiniHeading } from '@/components/player/mini-player';
import { usePlaceSync } from '@/components/player/place-sync';
import { usePlayerOnTop, usePlayerSheets } from '@/components/player/player-sheets';
import { addBookmarkHere } from '@/components/player/player-shortcuts';
import { SleepTimerButton } from '@/components/player/sleep-timer-button';
import { TransportControls } from '@/components/player/transport-controls';
import { UndoChip, useUndoVisible } from '@/components/player/undo-chip';
import { usePlayingPins } from '@/components/player/use-playing-pins';
import { SEGMENT_LABEL, usePlayingSegment } from '@/components/player/use-playing-segment';
import { usePlayingTimeLeft } from '@/components/player/use-time-left';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Slider } from '@/components/ui/slider';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { UpNextButton } from '@/components/upnext/up-next-button';
import { formatClock, formatSpeed } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { selectIsPlaying, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { useChromeEdge } from './shell-metrics';

/** The bar's height above the safe area (STYLEGUIDE "Docked player bar"). */
const DOCK_HEIGHT = 84;

/**
 * What the dock shows at its MEASURED width (the bar spans the window under the page and
 * the desktop drawer; a tablet, a split view or a narrow browser window is less): from
 * 1024 every action (speed, bookmark, output); below it the tablet set, whose hidden
 * actions are all in the full player; below 800 the chapter scrubber row goes too (the
 * transport alone fits between the book and the actions). While the Undo chip shows (ten
 * seconds after a jump) its MEASURED width (`undoWidth`: "Back to 17:26:50" is wider
 * than "Back to 2:00") comes off the width first, so the scrubber row and then the
 * secondary actions make way for it and the book keeps its title (at 834 the chip used
 * to crush it to "C...").
 */
export function dockLayout(
  width: number,
  undoWidth = 0,
): { allActions: boolean; scrubber: boolean } {
  const room = width - undoWidth;
  return { allActions: room >= 1024, scrubber: room >= 800 };
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

/** The dock's right-hand actions: 36 pt round pills like the sleep pill beside them
 * (`SleepTimerButton`), with a 44 pt target. */
const DOCK_PILL = 'h-9 min-w-9 flex-row gap-1.5 px-2.5';

/** The speed pill ("1.25×"), opening the speed sheet. */
function SpeedPill() {
  const { t } = useTranslation();
  const rate = usePlayer((s) => s.rate);
  return (
    <ControlPill
      testID="dock-speed"
      hitSlop={4}
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
 * listener's speed) in the centre; on the right the Undo chip after a jump, speed, sleep,
 * bookmark, output (where the engine can pick one), Up next and expand. What fits is
 * decided by the bar's measured width (`dockLayout`); everything hidden is in the full
 * player.
 *
 * Speed and sleep open through `usePlayerSheets` (the web's keys open the same sheets),
 * rendered by the shell's one sheet host. Renders a fragment so that host can sit beside
 * the bar in the shell's root column and cover the whole app.
 */
export function DockedPlayer() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const insets = useSafeAreaInsets();
  const desktop = useLayout() === 'desktop';
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const { heading } = useMiniHeading();
  const isPlaying = usePlayer(selectIsPlaying);
  const canRoutePick = usePlayer((s) => s.canRoutePick);
  const showRoutePicker = usePlayer((s) => s.showRoutePicker);
  const undo = useUndoVisible();
  const onTop = usePlayerOnTop();
  // The chip's width as it last laid out (it keeps it between jumps, so a chip that
  // reappears makes room at once); none while it is not showing.
  const [chipWidth, setChipWidth] = useState(0);
  // The playing book's bookmarks, once for the bar.
  const pins = usePlayingPins();
  // The bar sits on the window's bottom edge, so its height is its top edge (published
  // for the root toasts). Its width picks what fits.
  const [size, setSize] = useState<{ width: number; height: number }>();
  useChromeEdge('dock', nowPlaying ? size?.height : undefined);
  // Nothing under the full player: the bar is hidden there, and its per-tick leaves
  // would only redraw behind it.
  if (!nowPlaying || onTop) return null;

  // Before the first layout: the form factor's guess.
  const { allActions, scrubber } = dockLayout(
    size?.width ?? (desktop ? 1280 : 800),
    undo ? chipWidth : 0,
  );
  const { queue, title, author } = nowPlaying;
  const bookLine = author ? `${title} · ${author}` : title;
  const openPlayer = () => router.push('/player');

  return (
    <>
      <View
        testID="shell-docked-player"
        accessibilityLabel={t('shell.dock.label')}
        onLayout={(e) =>
          setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
        }
        style={{
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
        className="border-t border-border bg-card"
      >
        {/* The 3px whole-book progress line along the bar's top edge (a leaf). */}
        <BookProgressLine total={queue.total} className="absolute left-0 right-0 top-0 h-[3px]" />
        <View
          style={{ height: DOCK_HEIGHT }}
          className="flex-row items-center gap-4 pl-3.5 pr-4 lg:gap-5 lg:pr-5"
        >
          <AnimatedPressable
            onPress={openPlayer}
            accessibilityRole="button"
            accessibilityLabel={t('shell.openPlayer', { title })}
            className={cn(
              'min-w-0 flex-1 flex-row items-center gap-3 rounded-menu p-1.5 active:bg-accent',
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
              <Text variant="caption" numberOfLines={1}>
                {bookLine}
              </Text>
              <SyncState connectionId={nowPlaying.connectionId} playing={isPlaying} />
            </View>
          </AnimatedPressable>

          <View
            testID="dock-centre"
            className={cn('justify-center', scrubber && 'min-w-[300px] flex-[1.4]')}
          >
            <TransportControls size="sm" />
            {scrubber ? <ChapterScrubber bookmarks={pins.bookmarks} /> : null}
          </View>

          <View
            testID="dock-actions"
            // The cluster shares the bar's slack with the book, except while the Undo chip
            // is in it: then the book takes all of it (the chip already widened the cluster).
            className={cn(
              'shrink-0 basis-auto flex-row items-center justify-end gap-1',
              undo ? 'grow-0' : 'grow',
            )}
          >
            <UndoChip
              className="mr-1"
              onLayout={(e) => {
                const w = e.nativeEvent.layout.width;
                if (w > 0) setChipWidth(w);
              }}
            />
            {allActions ? <SpeedPill /> : null}
            <View testID="dock-sleep">
              <SleepTimerButton onPress={() => usePlayerSheets.getState().openSheet('sleep')} />
            </View>
            {allActions ? (
              <ControlPill
                testID="dock-bookmark"
                hitSlop={4}
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
                hitSlop={4}
                className={DOCK_PILL}
                label={t('player.routePicker.label')}
                onPress={() => void showRoutePicker()}
              >
                <Icon name="airplay" size={16} color={themed.foreground} />
              </ControlPill>
            ) : null}
            <UpNextButton variant="dock" />
            <ControlPill
              testID="dock-expand"
              hitSlop={4}
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
