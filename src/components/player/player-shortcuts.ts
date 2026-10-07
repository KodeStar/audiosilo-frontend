import type { TFunction } from 'i18next';

import { addBookmark } from '@/api/hooks';
import { toast } from '@/components/ui/toast';
import { formatClock } from '@/lib/format';
import type { ShortcutKey } from '@/lib/keyboard';
import { noteInteraction } from '@/playback/last-interaction';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

import { usePlayerSheets } from './player-sheets';
import { steppedRate } from './speed-model';
import { stepSegment } from './transport';

/**
 * The web player's keyboard (STYLEGUIDE section 11), as a pure key map plus the actions
 * it runs. `usePlayerShortcuts` attaches it to the document once, in the web shell.
 *
 * Space or K play/pause · J or ← back · L or → forward · ⇧← / ⇧→ previous / next chapter ·
 * [ and ] speed -/+ 0.05 · B bookmark · P full player · Z sleep · ? shortcuts · Esc closes
 * the top layer. (Q, Up next, and ⌘K or /, the palette, have their own handlers; the
 * overlay lists them too.)
 */

export type PlayerShortcut =
  | 'toggle'
  | 'back'
  | 'forward'
  | 'previousChapter'
  | 'nextChapter'
  | 'slower'
  | 'faster'
  | 'bookmark'
  | 'openPlayer'
  | 'sleep'
  | 'help'
  | 'close';

/** A keydown, as much of it as the map reads. */
export type PlayerKey = ShortcutKey & { shiftKey: boolean };

/** Where the keydown happened. */
export type PlayerKeyContext = {
  /** The focus is in something you type into: no shortcut. */
  editable: boolean;
  /** A dialog or a menu other than the player is open (the palette, a sheet, an alert,
   * the overflow menu): no shortcut, and Esc is the layer's own. */
  modalOpen: boolean;
  /** The focus is on a control that Space activates (a button, a link, a tab): Space is
   * left to it. A slider is not one, so Space over a focused scrubber plays and pauses. */
  focusOwnsSpace: boolean;
  /** The focus is on a control that moves with the arrows (a slider, tabs, a list's
   * options): the arrows are left to it. A button is not one, so after a click on play
   * the arrows still skip. */
  focusOwnsArrows: boolean;
  /** A book is loaded (every shortcut but ? needs one). */
  loaded: boolean;
};

const LETTERS: Record<string, PlayerShortcut> = {
  k: 'toggle',
  j: 'back',
  l: 'forward',
  b: 'bookmark',
  p: 'openPlayer',
  z: 'sleep',
};

/** The shortcut a keydown means, or null. Pure. */
export function playerShortcutFor(e: PlayerKey, ctx: PlayerKeyContext): PlayerShortcut | null {
  if (ctx.editable || ctx.modalOpen) return null;
  // Many layouts (German, French, Nordic...) type [ and ] with AltGr (Ctrl+Alt on Windows)
  // or Option (macOS), so for those two the character counts, not the modifiers. Never
  // with Cmd or a bare Ctrl, which are browser and system shortcuts.
  const bracket = (e.key === '[' || e.key === ']') && !e.metaKey && (e.altKey || !e.ctrlKey);
  if ((e.metaKey || e.ctrlKey || e.altKey) && !bracket) return null;
  if (e.key === '?') return 'help';
  if (e.key === 'Escape') return 'close';
  if (!ctx.loaded) return null;
  if (e.key === ' ' && ctx.focusOwnsSpace) return null;
  const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  if (arrow && ctx.focusOwnsArrows) return null;
  if (e.key === ' ') return 'toggle';
  if (e.key === 'ArrowLeft') return e.shiftKey ? 'previousChapter' : 'back';
  if (e.key === 'ArrowRight') return e.shiftKey ? 'nextChapter' : 'forward';
  if (e.key === '[') return 'slower';
  if (e.key === ']') return 'faster';
  return LETTERS[e.key.toLowerCase()] ?? null;
}

/** The bookmark being added, while it is (`addBookmarkHere`). */
let adding: Promise<void> | null = null;

/**
 * Add a bookmark at the playing book's current position, on its own server, and say so
 * ("Bookmark added", the clock). Framework-free (the shortcut can fire from any page),
 * through the PLAYING book's connection. One at a time: a double tap on the companion's
 * button, or B held down, while one is on its way adds nothing more (the caller gets the
 * one in flight).
 */
export function addBookmarkHere(t: TFunction): Promise<void> {
  adding ??= addNow(t).finally(() => {
    adding = null;
  });
  return adding;
}

async function addNow(t: TFunction): Promise<void> {
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np) return;
  // A bookmark is a deliberate touch the store can't see: the drift prompt measures from
  // it, whichever surface made it (a pill, the B key, the companion).
  noteInteraction();
  const position = Math.round(selectBookPosition(player));
  try {
    await addBookmark(np.connectionId, np.libraryId, np.path, position);
    toast({ title: t('player.bookmarks.added'), description: formatClock(position) });
  } catch (err) {
    console.warn('[shortcuts] bookmark failed', err);
    toast({ title: t('player.bookmarks.addFailed') });
  }
}

/** What the shortcuts need from the surface they run on. */
export type ShortcutEnv = {
  t: TFunction;
  /** The full player is the top layer. */
  onPlayer: boolean;
  openPlayer: () => void;
  closePlayer: () => void;
};

/** Run a shortcut against the player store and the sheets. Returns whether it did
 * anything (Esc with nothing to close, or P on the player, leave the key alone). */
export function runPlayerShortcut(action: PlayerShortcut, env: ShortcutEnv): boolean {
  const player = usePlayer.getState();
  const sheets = usePlayerSheets.getState();
  const { skipForward, skipBackward } = useSettings.getState();
  switch (action) {
    case 'toggle':
      void (player.snapshot.state === 'error' ? player.retry() : player.toggle());
      return true;
    case 'back':
      void player.skipSeconds(-skipBackward);
      return true;
    case 'forward':
      void player.skipSeconds(skipForward);
      return true;
    case 'previousChapter':
      stepSegment(player, -1);
      return true;
    case 'nextChapter':
      stepSegment(player, 1);
      return true;
    case 'slower':
      void player.setRate(steppedRate(player.rate, -1));
      return true;
    case 'faster':
      void player.setRate(steppedRate(player.rate, 1));
      return true;
    case 'bookmark':
      void addBookmarkHere(env.t);
      return true;
    case 'openPlayer':
      if (env.onPlayer) return false;
      env.openPlayer();
      return true;
    case 'sleep':
      sheets.openSheet('sleep');
      return true;
    case 'help':
      sheets.openSheet('shortcuts');
      return true;
    case 'close':
      if (sheets.open) sheets.close();
      else if (env.onPlayer) env.closePlayer();
      else return false;
      return true;
  }
}
