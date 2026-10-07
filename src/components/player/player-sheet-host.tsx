import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';

import { bottomChromeTop, useShellMetrics } from '@/components/shell/shell-metrics';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRootInsets } from '@/components/ui/overlay';
import { Sheet } from '@/components/ui/sheet';
import { useLayout } from '@/lib/layout';
import { usePlayer } from '@/playback/store';

import { ChaptersPanel } from './companion/chapters-panel';
import { Companion } from './companion/companion';
import { useCompanion } from './companion/companion-store';
import { GraceCard } from './grace-card';
import { addBookmarkHere } from './player-shortcuts';
import {
  hostIsActive,
  type SheetHostScope,
  usePlayerOnTop,
  usePlayerSheets,
} from './player-sheets';
import { SleepSheet } from './sleep-timer-button';
import { SpeedSheet } from './speed-button';

/** A sheet holding its own scroller (the chapter list, the companion): a bottom sheet
 * of a fixed height on a phone and tablet, a centred dialog on desktop, matching
 * `PlayerSheet` (which wraps its body in a ScrollView, so a list can't live in it). */
function ListSheet({
  visible,
  onClose,
  title,
  fraction,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** The body's height, as a fraction of the window. */
  fraction: number;
  children: ReactNode;
}) {
  const layout = useLayout();
  const { height } = useWindowDimensions();
  const body = Math.round(height * fraction) - 64;
  if (layout === 'desktop') {
    return (
      <Dialog open={visible} onOpenChange={(open) => (open ? null : onClose())}>
        {visible ? (
          <DialogContent className="max-w-[480px] gap-3 px-0 pb-0">
            <DialogHeader className="px-6">
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <View style={{ height: Math.min(body, 560) }}>{children}</View>
          </DialogContent>
        ) : null}
      </Dialog>
    );
  }
  return (
    <Sheet visible={visible} onClose={onClose} title={title} maxHeightFraction={fraction + 0.04}>
      <View style={{ height: body }}>{children}</View>
    </Sheet>
  );
}

/**
 * The player's sheets, rendered from `usePlayerSheets` (STYLEGUIDE section 8, "Sheets"):
 * speed, sleep, the chapter list and, in the full player on a phone, the companion
 * sheet. `bookmark` and `output` are actions, not sheets: asking for one adds a
 * bookmark here (with its toast) or shows the system route picker. `shortcuts` is the
 * web shell's `ShortcutsDialog`.
 *
 * Mounted twice: inside the full player (`scope="player"`) and once in the app shell
 * (`scope="shell"`, for the docked bar and the mini players). Only one is active at a
 * time (`hostIsActive`): the shell's stands back while the full player is on top. The
 * full player's host closes its sheet when the player goes away, so it doesn't reopen
 * in the shell. Esc closes the open sheet on the web (`runPlayerShortcut`).
 */
export function PlayerSheetHost({
  scope,
  chaptersInColumn = false,
}: {
  scope: SheetHostScope;
  /** The full player shows its chapters in the desktop companion column: a request for
   * the chapter sheet opens that tab instead. */
  chaptersInColumn?: boolean;
}) {
  const { t } = useTranslation();
  const playerOnTop = usePlayerOnTop();
  const active = hostIsActive(scope, playerOnTop);
  const loaded = usePlayer((s) => s.nowPlaying !== null);
  const title = usePlayer((s) => s.nowPlaying?.title ?? '');
  // A book without a whole-book timeline lists its files.
  const perFile = usePlayer((s) => (s.nowPlaying?.queue.total ?? 1) <= 0);
  const open = usePlayerSheets((s) => s.open);
  const close = usePlayerSheets((s) => s.close);
  const shown = active && loaded ? open : null;

  // The requests that are actions, not sheets.
  useEffect(() => {
    if (shown === 'bookmark') {
      close();
      void addBookmarkHere(t);
    } else if (shown === 'output') {
      close();
      const player = usePlayer.getState();
      if (player.canRoutePick) void player.showRoutePicker();
    } else if (shown === 'chapters' && chaptersInColumn) {
      close();
      useCompanion.getState().setTab('chapters');
    }
  }, [shown, close, t, chaptersInColumn]);

  // The full player's sheet goes with it (the keyboard overlay is the shell's own).
  useEffect(() => {
    if (scope !== 'player') return;
    return () => {
      const s = usePlayerSheets.getState();
      if (s.open && s.open !== 'shortcuts') s.close();
    };
  }, [scope]);

  return (
    <>
      <SpeedSheet visible={shown === 'speed'} onClose={close} />
      <SleepSheet visible={shown === 'sleep'} onClose={close} />
      <ListSheet
        visible={shown === 'chapters' && !chaptersInColumn}
        onClose={close}
        title={perFile ? t('player.chapters.filesTitle') : t('player.chapters.chaptersTitle')}
        fraction={0.7}
      >
        <View className="flex-1 px-2">
          <ChaptersPanel virtualized onSelected={close} />
        </View>
      </ListSheet>
      {scope === 'player' ? (
        <ListSheet visible={shown === 'companion'} onClose={close} title={title} fraction={0.78}>
          <Companion variant="sheet" onChapter={close} className="px-4" />
        </ListSheet>
      ) : null}
    </>
  );
}

/** The sleep timer's grace card on a phone, outside the full player: lifted clear of the
 * measured bottom chrome (the tab bar, the mini player). Tablet and desktop show it from
 * the docked bar; the full player mounts its own. */
function PhoneGraceCard() {
  const phone = useLayout() === 'phone';
  const playerOnTop = usePlayerOnTop();
  const insets = useRootInsets();
  const chromeTop = useShellMetrics((s) => bottomChromeTop(s.edges));
  if (!phone || playerOnTop) return null;
  return <GraceCard bottom={(chromeTop ?? insets.bottom + 120) + 12} />;
}

/**
 * The player's overlays at the app shell's root (both platform layouts mount it once,
 * beside Up next's sheet): the sheet host for the docked bar and the mini players, and
 * the phone's grace card. Renders in place, so it must sit at the shell's root.
 */
export function ShellPlayerOverlays() {
  return (
    <>
      <PhoneGraceCard />
      <PlayerSheetHost scope="shell" />
    </>
  );
}
