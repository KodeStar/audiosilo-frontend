import { router } from 'expo-router';

import { startBookInPlace } from '@/components/player/start-book';
import type { PlayTarget } from '@/components/player/use-play-book';
import { contentKey } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { selectBookKey, selectIsTransportLive, usePlayer } from '@/playback/store';

/** The player route at a position (`playerHref` plus `position`): it starts the book
 * there, or jumps the loaded one. */
export function playerAt(target: PlayTarget, position: number) {
  return {
    pathname: '/player' as const,
    params: {
      connection: target.connectionId,
      libraryId: String(target.libraryId),
      path: target.path,
      position: String(Math.max(0, Math.round(position))),
    },
  };
}

/**
 * Play a book from a place in it: a Journal row's "Jump", a drift-off's "Jump back".
 * The shared play path, with the place:
 * - a phone opens the full player there (the route starts the book at `position`, or
 *   jumps the loaded one; the jump shows its Undo chip in the player);
 * - a tablet or desktop jumps the loaded book in place under the docked bar (a jump, so
 *   the dock's Undo chip offers the way back) and plays it, or starts another book there
 *   (`startBookInPlace`, which lowers the resume floor to that place).
 * Rejects when the book can't be fetched, so the caller can say so.
 */
export function useJumpTo() {
  const phone = useLayout() === 'phone';
  return async (target: PlayTarget, position: number): Promise<void> => {
    if (phone) {
      router.push(playerAt(target, position));
      return;
    }
    const store = usePlayer.getState();
    if (selectBookKey(store) === contentKey(target.connectionId, target.libraryId, target.path)) {
      await store.seekBook(position);
      if (!selectIsTransportLive(usePlayer.getState())) await usePlayer.getState().toggle();
      return;
    }
    await startBookInPlace(target, { position });
  };
}
