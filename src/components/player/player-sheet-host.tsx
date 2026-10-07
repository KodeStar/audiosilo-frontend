import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { UpNextSheet } from '@/components/upnext/up-next-sheet';
import { type LayoutClass, useLayout } from '@/lib/layout';
import { usePlayer } from '@/playback/store';

import { ChaptersPanel } from './companion/chapters-panel';
import { Companion } from './companion/companion';
import { GraceCard } from './grace-card';
import { PlayerSheet } from './player-sheet';
import { addBookmarkHere } from './player-shortcuts';
import {
  hostIsActive,
  type PlayerSheet as PlayerSheetName,
  type SheetHostScope,
  usePlayerOnTop,
  usePlayerSheets,
} from './player-sheets';
import { SleepSheet } from './sleep-timer-button';
import { SpeedSheet } from './speed-button';

/** The requests that need a loaded book (Up next and the shortcuts overlay do not). */
const BOOK_SHEETS: ReadonlySet<PlayerSheetName> = new Set([
  'speed',
  'sleep',
  'bookmark',
  'output',
  'chapters',
  'companion',
]);

/**
 * The player's sheets, rendered from `usePlayerSheets` (STYLEGUIDE section 8, "Sheets"):
 * speed, sleep, the chapter list, the companion and Up next. A request says what, this
 * host decides the form by its layout (the full player's MEASURED one, the window's in
 * the shell):
 * - `chapters`: the companion's Chapters tab where the full player shows the companion in
 *   a column (desktop) or as a sheet (phone: one chapters UI there, the companion sheet);
 *   the chapter sheet otherwise (the tablet player, the shell).
 * - `companion` (`openCompanion`): its sheet on a phone; wider, the full player's column
 *   or inline companion already shows the tab, so the request just closes. The shell
 *   leaves it for the full player it is opening (the reveal toast's Show).
 * - `upnext`: Up next's sheet on a tablet or phone, with or without a book loaded.
 * - `bookmark` and `output` are actions, not sheets: a bookmark here (with its toast) or
 *   the system route picker. `shortcuts` is the web shell's `ShortcutsDialog`.
 *
 * Mounted twice: inside the full player (`scope="player"`, with its measured `layout`)
 * and once in the app shell (`scope="shell"`, for the docked bar, the mini players and
 * Up next). Only one is active at a time (`hostIsActive`): the shell's stands back while
 * the full player is on top. The full player's host closes its sheet when the player goes
 * away, so it doesn't reopen in the shell. Esc closes the open sheet on the web.
 */
export function PlayerSheetHost({
  scope,
  layout: playerLayout,
}: {
  scope: SheetHostScope;
  /** The full player's measured layout (the shell uses the window's). */
  layout?: LayoutClass;
}) {
  const { t } = useTranslation();
  const windowLayout = useLayout();
  const layout = playerLayout ?? windowLayout;
  const inPlayer = scope === 'player';
  const playerOnTop = usePlayerOnTop();
  const active = hostIsActive(scope, playerOnTop);
  const loaded = usePlayer((s) => s.nowPlaying !== null);
  const title = usePlayer((s) => s.nowPlaying?.title ?? '');
  // A book without a whole-book timeline lists its files.
  const perFile = usePlayer((s) => (s.nowPlaying?.queue.total ?? 1) <= 0);
  const open = usePlayerSheets((s) => s.open);
  const close = usePlayerSheets((s) => s.close);
  const request = active ? open : null;
  // The player's own sheets need a book; Up next does not.
  const shown = loaded ? request : null;
  // Where the full player shows the companion itself (a column, inline), or as a sheet.
  const companionSheet = inPlayer && layout === 'phone';

  // The requests this host turns into something else.
  useEffect(() => {
    if (shown === 'bookmark') {
      close();
      void addBookmarkHere(t);
    } else if (shown === 'output') {
      close();
      const player = usePlayer.getState();
      if (player.canRoutePick) void player.showRoutePicker();
    } else if (shown === 'chapters' && inPlayer && layout !== 'tablet') {
      usePlayerSheets.getState().openCompanion('chapters');
    } else if (shown === 'companion' && inPlayer && !companionSheet) {
      close();
    }
  }, [shown, close, t, inPlayer, layout, companionSheet]);

  // A book's sheets go with the book: when it unloads (it ended, Mark as finished) the
  // hidden request is dropped, or the next book to load would open it by itself.
  useEffect(() => {
    if (!active || loaded || !open || !BOOK_SHEETS.has(open)) return;
    close();
  }, [active, loaded, open, close]);

  // The full player's sheet goes with it (the keyboard overlay is the shell's own).
  useEffect(() => {
    if (!inPlayer) return;
    return () => {
      const s = usePlayerSheets.getState();
      if (s.open && s.open !== 'shortcuts') s.close();
    };
  }, [inPlayer]);

  return (
    <>
      <SpeedSheet visible={shown === 'speed'} onClose={close} />
      <SleepSheet visible={shown === 'sleep'} onClose={close} />
      <PlayerSheet
        visible={shown === 'chapters' && !(inPlayer && layout !== 'tablet')}
        onClose={close}
        title={perFile ? t('player.chapters.filesTitle') : t('player.chapters.chaptersTitle')}
        body="fill"
        fraction={0.7}
      >
        <View className="flex-1 px-2">
          <ChaptersPanel virtualized onSelected={close} />
        </View>
      </PlayerSheet>
      {inPlayer ? (
        <PlayerSheet
          visible={shown === 'companion' && companionSheet}
          onClose={close}
          title={title}
          body="fill"
          fraction={0.78}
        >
          <Companion variant="sheet" onChapter={close} className="px-4" />
        </PlayerSheet>
      ) : null}
      <UpNextSheet visible={request === 'upnext'} onClose={close} />
    </>
  );
}

/** The sleep timer's floating grace card outside the full player (which shows its own in
 * the flow), above whatever bottom chrome the shell has. */
function ShellGraceCard() {
  const playerOnTop = usePlayerOnTop();
  return playerOnTop ? null : <GraceCard />;
}

/**
 * The player's overlays at the app shell's root (both platform layouts mount it once):
 * the sheet host for the docked bar, the mini players and Up next, and the floating
 * grace card. Renders in place, so it must sit at the shell's root.
 */
export function ShellPlayerOverlays() {
  return (
    <>
      <ShellGraceCard />
      <PlayerSheetHost scope="shell" />
    </>
  );
}
