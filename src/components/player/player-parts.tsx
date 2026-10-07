import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';

import { useCapability, useLibrariesAll } from '@/api/hooks';
import type { Book } from '@/api/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HORIZONTAL_SCROLLER } from '@/components/ui/horizontal-scroller';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { openUpNext } from '@/components/upnext/up-next-store';
import { useUpNextBadge } from '@/components/upnext/use-up-next';
import { formatCount, formatSpeed } from '@/lib/format';
import { bookHref, finishedHref } from '@/lib/paths';
import { percentHeard } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { selectUndoFor, useJumpUndo } from '@/playback/jump-undo';
import { selectBookKey, selectBookPosition, selectIsPlaying, usePlayer } from '@/playback/store';
import { useSession } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { COMPANION_TAB_LABEL, type CompanionTab } from './companion/companion-model';
import { ControlPill, type PillLook, pillClass } from './control-pill';
import { usePlaceSync } from './place-sync';
import { addBookmarkHere } from './player-shortcuts';
import { usePlayerSheets } from './player-sheets';
import { playerContext } from './player-view-model';
import { UndoChip } from './undo-chip';
import { useSleepPill } from './use-sleep-countdown';
import { usePlayingTimeLeft } from './use-time-left';

/** The header's round 44 pt buttons. */
const ROUND = 'h-11 w-11';

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
      <ControlPill onPress={onClose} label={t('player.full.minimise')} className={ROUND}>
        <Icon name="chevron-down" size={22} color={themed.foreground} />
      </ControlPill>
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
          className={pillClass('ghost', ROUND)}
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
 * The status line under the titles: where the place is kept (`usePlaceSync`, the dock's
 * words), how much of the book is heard and the time left at the book's speed. It
 * becomes the Undo chip while a jump can be undone.
 */
export function PlayerStatusLine() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const cid = usePlayer((s) => s.nowPlaying?.connectionId ?? '');
  const total = usePlayer((s) => s.nowPlaying?.queue.total ?? 0);
  const playing = usePlayer(selectIsPlaying);
  const bookKey = usePlayer(selectBookKey);
  const undo = useJumpUndo(selectUndoFor(bookKey));
  const sync = usePlaceSync(cid, playing);
  const percent = usePlayingPercent();
  const left = usePlayingTimeLeft();

  if (undo) {
    return (
      <View className="h-[34px] items-center justify-center">
        <UndoChip />
      </View>
    );
  }
  const parts = [
    sync?.text ?? '',
    total > 0 ? t('player.full.percentOfBook', { percent }) : '',
    left,
  ].filter(Boolean);
  return (
    <View className="h-[34px] flex-row items-center justify-center gap-1.5 px-2">
      {sync ? <Icon name={sync.icon} size={13} color={themed.mutedForeground} /> : null}
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
  look = 'outline',
  testID,
}: {
  icon?: IconName;
  label: string;
  text?: string;
  onPress: () => void;
  look?: PillLook;
  testID?: string;
}) {
  const themed = useThemeColors();
  const active = look === 'active';
  return (
    <ControlPill
      onPress={onPress}
      look={look}
      label={label}
      testID={testID}
      className="h-11 min-w-[44px] flex-row gap-2 px-3.5"
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
    </ControlPill>
  );
}

/** The sleep pill (`useSleepPill`): the moon alone (with "Sleep" where there is room);
 * with a timer, its countdown on brand-soft; "Keep going" once the timer has paused
 * playback. */
function SleepPill({ wide }: { wide: boolean }) {
  const { t } = useTranslation();
  const { active, text, label } = useSleepPill();
  return (
    <Pill
      icon="sleep"
      text={text ?? (wide ? t('player.full.sleep') : undefined)}
      label={label}
      look={active ? 'active' : 'outline'}
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
        onPress={() => void addBookmarkHere(t)}
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

/** The companion chips' tabs and glyphs. */
const CHIPS: { tab: CompanionTab; icon: IconName; community: boolean }[] = [
  { tab: 'who', icon: 'users', community: true },
  { tab: 'story', icon: 'book-open', community: true },
  { tab: 'chapters', icon: 'list', community: false },
];

/** The phone's way into the companion: Who's who, Story so far (where the server has
 * community data) and Chapters, each opening the companion on that tab and named as the
 * companion names its tabs. One row, centred where it fits and scrolling sideways where
 * it doesn't (a narrow phone, a long translation), so it never wraps the player past the
 * fold. */
export function CompanionChips() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const cid = usePlayer((s) => s.nowPlaying?.connectionId);
  const metadata = useCapability('metadata', cid) === true;
  return (
    <ScrollView
      horizontal
      testID="player-companion-chips"
      showsHorizontalScrollIndicator={false}
      style={HORIZONTAL_SCROLLER}
      className="w-full"
      contentContainerClassName="grow justify-center gap-2"
    >
      {CHIPS.filter((c) => metadata || !c.community).map(({ tab, icon }) => {
        const label = t(COMPANION_TAB_LABEL[tab]);
        return (
          <ControlPill
            key={tab}
            look="outline"
            label={label}
            onPress={() => usePlayerSheets.getState().openCompanion(tab)}
            className="h-11 flex-row gap-1.5 px-3"
          >
            <Icon name={icon} size={15} color={themed.foreground} />
            <Text variant="label" numberOfLines={1}>
              {label}
            </Text>
          </ControlPill>
        );
      })}
    </ScrollView>
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

/** Children laid out as the main column of the player (centred, capped); `fill` grows it
 * to the height it is given (a phone's column, whose cover takes what is left). */
export function PlayerColumn({
  children,
  maxWidth,
  fill = false,
}: {
  children: ReactNode;
  maxWidth: number;
  fill?: boolean;
}) {
  return (
    <View
      className={cn('w-full items-center gap-4 self-center', fill && 'flex-1')}
      style={{ maxWidth }}
    >
      {children}
    </View>
  );
}
