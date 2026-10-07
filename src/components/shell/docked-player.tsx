import { router } from 'expo-router';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { serverStatus, useReachability } from '@/api/reachability';
import { BookCover } from '@/components/library/book-cover';
import { BookProgressLine } from '@/components/player/book-progress';
import { GraceCard } from '@/components/player/grace-card';
import { usePlayerSheets } from '@/components/player/player-sheets';
import { addBookmarkHere } from '@/components/player/player-shortcuts';
import { SleepTimerButton } from '@/components/player/sleep-timer-button';
import { currentSegment } from '@/components/player/transport';
import { TransportControls } from '@/components/player/transport-controls';
import { UndoChip } from '@/components/player/undo-chip';
import { usePlayingPins } from '@/components/player/use-playing-pins';
import { usePlayingTimeLeft } from '@/components/player/use-time-left';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon, type IconName } from '@/components/ui/icon';
import { Slider } from '@/components/ui/slider';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { UpNextButton } from '@/components/upnext/up-next-button';
import { chapterLabel } from '@/lib/chapter-label';
import { formatClock, formatSpeed } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { selectUndoFor, useJumpUndo } from '@/playback/jump-undo';
import {
  selectBookKey,
  selectBookPosition,
  selectCurrentChapter,
  selectIsPlaying,
  usePlayer,
} from '@/playback/store';
import { useSession } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { useChromeEdge } from './shell-metrics';

/** The bar's height above the safe area (STYLEGUIDE "Docked player bar"). */
const DOCK_HEIGHT = 84;

/** The room the Undo chip takes in the right cluster ("Back to 17:26:50", its ring and
 * margin), which comes out of the room the rest of the dock is laid out in. */
export const UNDO_CHIP_ROOM = 180;

/**
 * What the dock shows at its MEASURED width (the bar spans the window under the page and
 * the desktop drawer; a tablet, a split view or a narrow browser window is less): from
 * 1024 every action (speed, bookmark, output); below it the tablet set, whose hidden
 * actions are all in the full player; below 800 the chapter scrubber row goes too (the
 * transport alone fits between the book and the actions). While the Undo chip shows
 * (`undo`, ten seconds after a jump) its room is taken off the width first, so the
 * scrubber row and then the secondary actions make way for it and the book keeps its
 * title (at 834 the chip used to crush it to "C...").
 */
export function dockLayout(
  width: number,
  undo = false,
): { allActions: boolean; scrubber: boolean } {
  const room = undo ? width - UNDO_CHIP_ROOM : width;
  return { allActions: room >= 1024, scrubber: room >= 800 };
}

/** Bookmark positions inside the current segment, as fractions of it (0..1). */
export function segmentTicks(bookmarks: readonly number[], start: number, length: number) {
  return bookmarks
    .filter((p) => p >= start && p < start + length)
    .map((p) => (p - start) / Math.max(1, length));
}

/** The chapter scrubber row: elapsed in the chapter, a thin scrubber with the chapter's
 * bookmark ticks, and the time left in the whole book at the listener's speed. A
 * per-tick leaf that moves in whole seconds (the clock's resolution), so it re-renders
 * about once a second, not per engine tick. */
function ChapterScrubber({ total }: { total: number }) {
  const { t } = useTranslation();
  const chapter = usePlayer(selectCurrentChapter);
  const trackDuration = usePlayer((s) => s.snapshot.duration);
  const elapsedSecond = usePlayer((s) =>
    Math.floor(
      currentSegment({
        total,
        bookPosition: selectBookPosition(s),
        chapter: selectCurrentChapter(s),
        trackPosition: s.snapshot.position,
        trackDuration: s.snapshot.duration,
      }).elapsed,
    ),
  );
  const left = usePlayingTimeLeft();
  const pins = usePlayingPins();
  const seekBook = usePlayer((s) => s.seekBook);
  const seekInTrack = usePlayer((s) => s.seekInTrack);
  const [scrub, setScrub] = useState<number | null>(null);
  const segment = {
    ...currentSegment({ total, bookPosition: 0, chapter, trackPosition: 0, trackDuration }),
    elapsed: elapsedSecond,
  };
  const ticks = useMemo(
    () => (segment.perTrack ? [] : segmentTicks(pins.bookmarks, segment.start, segment.length)),
    [pins.bookmarks, segment.perTrack, segment.start, segment.length],
  );
  const onSeek = (p: number) =>
    segment.perTrack ? void seekInTrack(p) : void seekBook(segment.start + p);
  return (
    <View className="-my-2.5 flex-row items-center gap-2.5">
      <Text variant="caption" style={tabularNums} className="min-w-[44px] text-right">
        {formatClock(scrub ?? segment.elapsed)}
      </Text>
      <View className="min-w-0 flex-1">
        <Slider
          value={segment.elapsed}
          max={Math.max(0, segment.length)}
          step={15}
          tone="ink"
          onValueCommit={onSeek}
          onPreview={setScrub}
          accessibilityLabel={t(segment.perTrack ? 'player.seek.labelFile' : 'player.seek.label')}
          valueText={(v) =>
            t('player.seek.value', {
              position: formatClock(v),
              duration: formatClock(segment.length),
            })
          }
        />
        {/* The chapter's bookmarks, ticks over the track (decoration: the full player's
            bookmark list is the accessible way to them). */}
        {ticks.map((f, i) => (
          <View
            key={`${i}-${f}`}
            testID="dock-bookmark-tick"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="absolute top-1/2 -mt-[5.5px] h-[11px] w-0.5 rounded-[1px] bg-foreground/55"
            style={{ left: `${f * 100}%`, marginLeft: -1 }}
          />
        ))}
      </View>
      <Text variant="caption" style={tabularNums} numberOfLines={1}>
        {left}
      </Text>
    </View>
  );
}

/** Where the place lives (STYLEGUIDE section 9, "reliability shown"), truthfully: synced
 * to the server (the store saves every 15 s while playing, so "just now" then; "Synced"
 * once paused, which saved too), kept on this device while the server is unreachable
 * (the offline queue replays it), or kept here until the listener signs in again (the
 * server refused the token, so nothing replays until then). Nothing for a book whose
 * server was removed (a download playing on). */
function SyncState({ connectionId, playing }: { connectionId: string; playing: boolean }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const connection = useSession((s) => s.connections.find((c) => c.id === connectionId));
  const needsReconnect = connection?.needsReconnect;
  const status = useReachability((s) =>
    serverStatus({ id: connectionId, needsReconnect }, s.online),
  );
  if (!connection) return null;
  const [icon, text]: [IconName, string] =
    status === 'reconnect'
      ? ['hard-drive', t('shell.dock.signInToSync')]
      : status === 'offline'
        ? ['hard-drive', t('shell.dock.savedLocally')]
        : ['cloud', playing ? t('shell.dock.syncedNow') : t('shell.dock.synced')];
  return (
    <View testID="dock-sync-state" className="flex-row items-center gap-[5px]">
      <Icon name={icon} size={12} color={themed.subtleForeground} />
      <Text variant="caption" className="text-[11px] text-subtle-foreground" numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** One of the dock's right-hand actions: a 36 pt round pill like the sleep pill beside it
 * (`SleepTimerButton`), with a 44 pt target. */
function DockPill({
  label,
  onPress,
  testID,
  children,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  children: ReactNode;
}) {
  return (
    <AnimatedPressable
      testID={testID}
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={cn(
        'h-9 min-w-9 flex-row items-center justify-center gap-1.5 rounded-full px-2.5 active:bg-accent',
        Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
      )}
    >
      {children}
    </AnimatedPressable>
  );
}

/** The speed pill ("1.25×"), opening the speed sheet. */
function SpeedPill() {
  const { t } = useTranslation();
  const rate = usePlayer((s) => s.rate);
  return (
    <DockPill
      testID="dock-speed"
      label={t('shell.dock.speed', { speed: formatSpeed(rate) })}
      onPress={() => usePlayerSheets.getState().openSheet('speed')}
    >
      <Text className="font-sans-bold text-[12.5px] text-foreground" style={tabularNums}>
        {formatSpeed(rate)}
      </Text>
    </DockPill>
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
  const chapter = usePlayer(selectCurrentChapter);
  const isPlaying = usePlayer(selectIsPlaying);
  const canRoutePick = usePlayer((s) => s.canRoutePick);
  const showRoutePicker = usePlayer((s) => s.showRoutePicker);
  const undo = useJumpUndo(selectUndoFor(usePlayer(selectBookKey))) !== null;
  // The bar sits on the window's bottom edge, so its height is its top edge (published
  // for the root toasts). Its width picks what fits.
  const [size, setSize] = useState<{ width: number; height: number }>();
  useChromeEdge('dock', nowPlaying ? size?.height : undefined);
  if (!nowPlaying) return null;

  // Before the first layout: the form factor's guess.
  const { allActions, scrubber } = dockLayout(size?.width ?? (desktop ? 1280 : 800), undo);
  const { queue, title, author } = nowPlaying;
  const heading = chapter ? chapterLabel(chapter, t) : title;
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
            {scrubber ? <ChapterScrubber total={queue.total} /> : null}
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
            <UndoChip className="mr-1" />
            {allActions ? <SpeedPill /> : null}
            <View testID="dock-sleep">
              <SleepTimerButton onPress={() => usePlayerSheets.getState().openSheet('sleep')} />
            </View>
            {allActions ? (
              <DockPill
                testID="dock-bookmark"
                label={t('player.shortcuts.bookmark')}
                onPress={() => void addBookmarkHere(t)}
              >
                <Icon name="bookmark" size={16} color={themed.foreground} />
              </DockPill>
            ) : null}
            {allActions && canRoutePick ? (
              <DockPill
                testID="dock-output"
                label={t('player.routePicker.label')}
                onPress={() => void showRoutePicker()}
              >
                <Icon name="airplay" size={16} color={themed.foreground} />
              </DockPill>
            ) : null}
            <UpNextButton variant="dock" />
            <DockPill testID="dock-expand" label={t('shell.dock.expand')} onPress={openPlayer}>
              <Icon name="chevron-up" size={16} color={themed.foreground} />
            </DockPill>
          </View>
        </View>
      </View>
      {/* The sleep timer's last seconds and post-pause grace, just above the bar. */}
      <GraceCard bottom={(size?.height ?? DOCK_HEIGHT) + 12} />
    </>
  );
}
