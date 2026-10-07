import { contentKey } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { selectBookKey, selectIsTransportLive, usePlayer } from '@/playback/store';

import { usePlayerOnTop } from './player-sheets';
import { startBookInPlace } from './start-book';

/** A book to start: on which connection, library and path. */
export type PlayTarget = { connectionId: string; libraryId: number; path: string };

export type PlayOptions = {
  /** The caller's button is a play/pause for the book (Home's Now card): when the book
   * is already loaded it pauses or plays in place, on every layout. */
  toggle?: boolean;
  /** On a phone, push the book's page under the player, so closing the player lands on
   * the book (a book started from a list or Home), not where the press came from. */
  viaBookPage?: boolean;
};

/**
 * THE way a browse surface starts a book (Home, the Library, the series page, Up next):
 * - a phone opens the full player (which resumes from the saved place);
 * - a tablet or desktop plays it in place under the docked player bar
 *   (`startBookInPlace`: once its chapters are in, through the book's own connection);
 *   a book already loaded just plays on (or toggles, with `toggle`);
 * - with the full player already on top (Up next's sheet over it), every layout starts
 *   in place like a tablet: the open player shows the new book.
 * Resolves once the book is on its way; rejects when it couldn't be fetched, so the
 * caller can say so.
 */
export function usePlayBook() {
  const phone = useLayout() === 'phone';
  const playerOnTop = usePlayerOnTop();
  const { openBook, openPlayer } = useOpen();
  return async (target: PlayTarget, opts: PlayOptions = {}) => {
    const { connectionId, libraryId, path } = target;
    const store = usePlayer.getState();
    const loaded = selectBookKey(store) === contentKey(connectionId, libraryId, path);
    if (loaded && opts.toggle) {
      await store.toggle();
      return;
    }
    // Pushing the player over the open one would stack a second full player: minimised
    // twice, and when that book ends the credits replace only the top one, so closing
    // them lands on the lower player with nothing loaded (a bare spinner with no close
    // button, which an iOS full-screen modal can't be swiped away from).
    if (phone && !playerOnTop) {
      if (opts.viaBookPage) openBook(connectionId, libraryId, path);
      openPlayer(connectionId, libraryId, path);
      return;
    }
    if (loaded) {
      if (!selectIsTransportLive(store)) await store.toggle();
      return;
    }
    await startBookInPlace(target);
  };
}
