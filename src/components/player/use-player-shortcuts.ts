import { router, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { isEditable, isModalOpen, ownsArrows, ownsSpace } from '@/lib/keyboard';
import { useLatest } from '@/lib/use-latest';
import { usePlayer } from '@/playback/store';

import { playerShortcutFor, runPlayerShortcut } from './player-shortcuts';

/**
 * The web player's keyboard shortcuts (`player-shortcuts.ts`), attached to the document
 * for the life of the web shell, which mounts it once. They work on every page and over
 * the full player (a root modal route, not a dialog), never while typing, never over
 * another dialog or an open menu, and - except ? - only with a book loaded. Space stands
 * aside for a focused control that Space activates, the arrows for one that moves with
 * them (`ownsSpace` / `ownsArrows`). A no-op off the web, or while `enabled` is false
 * (a shell that is not the top one: `useIsTopShell`).
 */
export function usePlayerShortcuts(enabled = true): void {
  const { t } = useTranslation();
  const onPlayer = (useSegments() as string[])[0] === 'player';
  const env = useLatest(() => ({
    t,
    onPlayer,
    openPlayer: () => router.push('/player'),
    closePlayer: () => router.back(),
  }));
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented) return;
      const active = document.activeElement;
      const action = playerShortcutFor(e, {
        editable: isEditable(active),
        modalOpen: isModalOpen(document),
        focusOwnsSpace: ownsSpace(active),
        focusOwnsArrows: ownsArrows(active),
        loaded: usePlayer.getState().nowPlaying !== null,
      });
      if (action && runPlayerShortcut(action, env())) e.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [env, enabled]);
}
