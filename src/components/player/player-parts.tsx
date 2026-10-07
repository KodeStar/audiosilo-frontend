import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useCapability, useLibrariesAll } from '@/api/hooks';
import { serverStatus, useReachability } from '@/api/reachability';
import type { Book } from '@/api/types';
import { usePendingSaves } from '@/components/home/use-sync-pill';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon, type IconName } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { openUpNext } from '@/components/upnext/up-next-store';
import { useUpNextBadge } from '@/components/upnext/use-up-next';
import { formatClock, formatCount, formatSpeed } from '@/lib/format';
import { bookHref, finishedHref } from '@/lib/paths';
import { percentHeard } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { noteInteraction } from '@/playback/last-interaction';
import { selectUndoFor, useJumpUndo } from '@/playback/jump-undo';
import { selectSleepExtendable, selectSleepPhase, useSleepTimer } from '@/playback/sleep-timer';
import { selectBookKey, selectBookPosition, usePlayer } from '@/playback/store';
import { useSession } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import type { CompanionTab } from './companion/companion-model';
import { useCompanion } from './companion/companion-store';
import { addBookmarkHere } from './player-shortcuts';
import { usePlayerSheets } from './player-sheets';
import { playerContext, syncState } from './player-view-model';
import { UndoChip } from './undo-chip';
import { usePlayingTimeLeft } from './use-time-left';

const roundIcon = cn(
  'h-11 w-11 items-center justify-center rounded-full active:bg-accent',
  Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
);

/**
 * The full player's top row: minimise on the left; "Playing from <server>" over the
 * book's place in its series (or its library) in the middle; the overflow menu on the
 * right (View book details, Chapters, View credits, Mark as finished, and Keyboard
 * shortcuts on the web).
 */
export function PlayerHeader({
  book,
  onClose,
  onChapters,
}: {
  book?: Book;
  onClose: () => void;
  onChapters: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const np = usePlayer((s) => s.nowPlaying);
  const server = useSession(
    (s) => s.connections.find((c) => c.id === np?.connectionId)?.name ?? '',
  );
  const { libraries } = useLibrariesAll();
  const library = libraries.find(
    (l) => l.connectionId === np?.connectionId && l.id === np?.libraryId,
  )?.name;
  const context = playerContext(book, library);
  if (!np) return null;
  const { connectionId, libraryId, path } = np;

  // These replace the player with where they go; playback runs on for the first two.
  const goTo = (href: Parameters<typeof router.replace>[0]) => router.replace(href);
  const onMarkFinished = () => {
    // finishBook persists finished, tears down the engine and clears nowPlaying; it
    // returns the finished book's identity.
    const info = usePlayer.getState().finishBook();
    if (info) goTo(finishedHref(info.connectionId, info.libraryId, info.path, true));
  };

  return (
    <View className="h-14 flex-row items-center gap-2 px-3">
      <AnimatedPressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('player.full.minimise')}
        className={roundIcon}
      >
        <Icon name="chevron-down" size={22} color={themed.foreground} />
      </AnimatedPressable>
      <View className="min-w-0 flex-1 items-center">
        {server ? (
          <Text variant="eyebrow" className="text-[10.5px]" numberOfLines={1}>
            {t('player.full.playingFrom', { server })}
          </Text>
        ) : null}
        {context ? (
          <Text variant="label" className="text-[13px]" numberOfLines={1}>
            {context.kind === 'series'
              ? context.position !== undefined
                ? t('player.full.seriesBook', {
                    series: context.series,
                    position: context.position,
                  })
                : context.series
              : context.name}
          </Text>
        ) : null}
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityLabel={t('player.menu.label')}
          className={roundIcon}
          testID="player-menu"
        >
          <Icon name="ellipsis" size={20} color={themed.foreground} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[240px]">
          <DropdownMenuItem
            icon="book-open"
            onPress={() => goTo(bookHref(connectionId, libraryId, path))}
          >
            <Text>{t('player.finished.viewDetails')}</Text>
          </DropdownMenuItem>
          <DropdownMenuItem icon="list" onPress={onChapters}>
            <Text>{t('player.chapters.chaptersTitle')}</Text>
          </DropdownMenuItem>
          <DropdownMenuItem
            icon="microphone"
            onPress={() => goTo(finishedHref(connectionId, libraryId, path))}
          >
            <Text>{t('player.menu.viewCredits')}</Text>
          </DropdownMenuItem>
          <DropdownMenuItem icon="circle-check" onPress={onMarkFinished}>
            <Text>{t('library.progressCard.markFinished')}</Text>
          </DropdownMenuItem>
          {Platform.OS === 'web' ? (
            <DropdownMenuItem
              icon="grid"
              onPress={() => usePlayerSheets.getState().openSheet('shortcuts')}
            >
              <Text>{t('player.shortcuts.title')}</Text>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

/** The percentage heard, in whole percent (a leaf: it redraws when the number moves). */
function usePlayingPercent(): number {
  return usePlayer((s) =>
    s.nowPlaying ? percentHeard(selectBookPosition(s), s.nowPlaying.queue.total, false) : 0,
  );
}

/**
 * The status line under the titles: where the place is kept ("Synced", or "Saved on this
 * device, will sync" while the book's server is offline or saves wait in the queue), how
 * much of the book is heard and the time left at the book's speed. It becomes the Undo
 * chip while a jump can be undone.
 */
export function PlayerStatusLine() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const cid = usePlayer((s) => s.nowPlaying?.connectionId ?? '');
  const total = usePlayer((s) => s.nowPlaying?.queue.total ?? 0);
  const bookKey = usePlayer(selectBookKey);
  const undo = useJumpUndo(selectUndoFor(bookKey));
  const needsReconnect = useSession((s) => s.connections.find((c) => c.id === cid)?.needsReconnect);
  const offline = useReachability(
    (s) => serverStatus({ id: cid, needsReconnect }, s.online) === 'offline',
  );
  const pending = usePendingSaves();
  const percent = usePlayingPercent();
  const left = usePlayingTimeLeft();

  if (undo) {
    return (
      <View className="h-[34px] items-center justify-center">
        <UndoChip />
      </View>
    );
  }
  const local = syncState(offline, pending) === 'local';
  const parts = [
    local ? t('shell.dock.savedLocally') : t('player.full.synced'),
    total > 0 ? t('player.full.percentOfBook', { percent }) : '',
    left,
  ].filter(Boolean);
  return (
    <View className="h-[34px] flex-row items-center justify-center gap-1.5 px-2">
      <Icon name={local ? 'hard-drive' : 'cloud'} size={13} color={themed.mutedForeground} />
      <Text variant="caption" numberOfLines={1} style={tabularNums} className="shrink">
        {parts.join(' · ')}
      </Text>
    </View>
  );
}

/** One of the player's action pills: a glyph, an optional word, a full label. */
function Pill({
  icon,
  label,
  text,
  onPress,
  active = false,
  testID,
}: {
  icon?: IconName;
  label: string;
  text?: string;
  onPress: () => void;
  active?: boolean;
  testID?: string;
}) {
  const themed = useThemeColors();
  return (
    <AnimatedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      className={cn(
        'h-11 min-w-[44px] flex-row items-center justify-center gap-2 rounded-full border px-3.5',
        active ? 'border-transparent bg-brand-soft' : 'border-border bg-card active:bg-accent',
        Platform.select({
          web: `cursor-pointer ${active ? '' : 'hover:bg-accent'} ${FOCUS_RING_OFFSET_CLASS}`,
        }),
      )}
    >
      {icon ? (
        <Icon name={icon} size={17} color={active ? themed.brandInk : themed.foreground} />
      ) : null}
      {text ? (
        <Text
          variant="label"
          className={active ? 'text-brand-ink' : undefined}
          style={tabularNums}
          numberOfLines={1}
        >
          {text}
        </Text>
      ) : null}
    </AnimatedPressable>
  );
}

/** The sleep pill: the moon alone (with "Sleep" where there is room); with a timer, its
 * countdown on brand-soft; "Keep going" once the timer has paused playback. */
function SleepPill({ wide }: { wide: boolean }) {
  const { t } = useTranslation();
  const phase = useSleepTimer(selectSleepPhase);
  const remaining = useSleepTimer((s) => s.remaining);
  const label = useSleepTimer((s) => s.label);
  const extendable = useSleepTimer(selectSleepExtendable);
  const active = phase !== 'idle';
  const text =
    phase === 'grace'
      ? t('player.sleepTimer.keepGoingShort')
      : active && remaining !== null
        ? formatClock(remaining)
        : wide
          ? t('player.full.sleep')
          : undefined;
  const a11y = extendable
    ? t('player.sleepTimer.keepListening')
    : active && label && remaining !== null
      ? t('player.sleepTimer.pillRunning', {
          label: t(label.key, label.params),
          time: formatClock(remaining),
        })
      : t('player.sleepTimer.title');
  return (
    <Pill
      icon="sleep"
      text={text}
      label={a11y}
      active={active}
      onPress={() => usePlayerSheets.getState().openSheet('sleep')}
      testID="player-sleep"
    />
  );
}

/**
 * The actions under the transport (STYLEGUIDE section 8, "Full player"): speed, sleep,
 * bookmark (one tap, at the current position, with a toast), output (where the device
 * can pick one) and Up next with its count (phone and tablet; a desktop has the drawer).
 * Words beside the glyphs where there is room (`wide`).
 */
export function PlayerActions({ wide, upNext }: { wide: boolean; upNext: boolean }) {
  const { t } = useTranslation();
  const rate = usePlayer((s) => s.rate);
  const canRoutePick = usePlayer((s) => s.canRoutePick);
  const showRoutePicker = usePlayer((s) => s.showRoutePicker);
  const { supported, count } = useUpNextBadge();
  const open = usePlayerSheets((s) => s.openSheet);
  return (
    <View className="flex-row flex-wrap items-center justify-center gap-2">
      <Pill
        text={formatSpeed(rate)}
        label={t('player.full.speedLabel', { speed: formatSpeed(rate) })}
        onPress={() => open('speed')}
        testID="player-speed"
      />
      <SleepPill wide={wide} />
      <Pill
        icon="bookmark"
        text={wide ? t('player.full.bookmark') : undefined}
        label={t('player.shortcuts.bookmark')}
        onPress={() => {
          noteInteraction();
          void addBookmarkHere(t);
        }}
        testID="player-bookmark"
      />
      {canRoutePick ? (
        <Pill
          icon="airplay"
          text={wide ? t('player.full.output') : undefined}
          label={t('player.routePicker.label')}
          onPress={() => void showRoutePicker()}
          testID="player-output"
        />
      ) : null}
      {upNext && supported === true ? (
        <Pill
          icon="queue"
          text={count > 0 ? formatCount(count) : undefined}
          label={count > 0 ? t('upnext.buttonLabel', { count }) : t('upnext.buttonLabelEmpty')}
          onPress={openUpNext}
          testID="player-upnext"
        />
      ) : null}
    </View>
  );
}

function Chip({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const themed = useThemeColors();
  return (
    <AnimatedPressable
      onPress={onPress}
      accessibilityRole="button"
      className={cn(
        'h-10 flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3.5 active:bg-accent',
        Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_OFFSET_CLASS}` }),
      )}
    >
      <Icon name={icon} size={15} color={themed.foreground} />
      <Text variant="label" numberOfLines={1}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

/** Open the companion sheet (a phone) on `tab`. */
export function openCompanionSheet(tab: CompanionTab) {
  useCompanion.getState().setTab(tab);
  usePlayerSheets.getState().openSheet('companion');
}

/** The phone's way into the companion: Who's who, Story so far (where the server has
 * community data) and Chapters, each opening the companion sheet on that tab. */
export function CompanionChips() {
  const { t } = useTranslation();
  const cid = usePlayer((s) => s.nowPlaying?.connectionId);
  const metadata = useCapability('metadata', cid) === true;
  const chips: { tab: CompanionTab; icon: IconName; label: string }[] = [
    ...(metadata
      ? ([
          { tab: 'who', icon: 'users', label: t('player.companion.who') },
          { tab: 'story', icon: 'book-open', label: t('book.meta.storySoFar') },
        ] as const)
      : []),
    { tab: 'chapters', icon: 'list', label: t('player.chapters.chaptersTitle') },
  ];
  return (
    <View className="flex-row flex-wrap justify-center gap-2">
      {chips.map((c) => (
        <Chip key={c.tab} icon={c.icon} label={c.label} onPress={() => openCompanionSheet(c.tab)} />
      ))}
    </View>
  );
}

/** A calm word under the transport when playback failed (Retry is the play button). */
export function PlayerErrorLine() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const error = usePlayer((s) => s.snapshot.state === 'error');
  if (!error) return null;
  return (
    <View className="flex-row items-center justify-center gap-1.5" accessibilityLiveRegion="polite">
      <Icon name="circle-exclamation" size={13} color={themed.destructive} />
      <Text variant="caption" className="text-destructive">
        {t('player.full.errorLine')}
      </Text>
    </View>
  );
}

/** Children laid out as the main column of the player (centred, capped). */
export function PlayerColumn({ children, maxWidth }: { children: ReactNode; maxWidth: number }) {
  return (
    <View className="w-full items-center gap-4 self-center" style={{ maxWidth }}>
      {children}
    </View>
  );
}
