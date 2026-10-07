import { contentKey } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import type { BookPlace } from '@/lib/paths';
import { currentNavState } from '@/lib/root-stack';
import { selectBookKey, selectIsTransportLive, usePlayer } from '@/playback/store';

import { navFor, type PlayTarget, playRoute } from './play-route';
import { startBookInPlace } from './start-book';

export type { PlayTarget } from './play-route';

export type PlayOptions = {
  /** The caller's button is a play/pause for the book (Home's Now card, the book page's
   * primary): when the book is already loaded it pauses or plays in place, on every
   * layout. */
  toggle?: boolean;
  /** On a phone, push the book's page under the player, so closing the player lands on
   * the book (a book started from a list or Home), not where the press came from. Not
   * when that page is already the one on screen (its own menu's Play). */
  viaBookPage?: boolean;
  /** Where to play from (a chapter row, a timeline tap, a pin, a bookmark or a history
   * span), else the saved place. The loaded book jumps there (`seekBook`, so the Undo
   * chip offers the way back) and plays on, also when it was paused. */
  at?: BookPlace;
};

/**
 * THE way anything outside the player starts a book or jumps into one (Home, the
 * Library, the series page, Up next, the book page, the bookmark and note rows, the
 * Journal), by `playRoute`:
 * - a phone opens the full player (which resumes from the saved place, or applies `at`
 *   once, also to the loaded book);
 * - a tablet or desktop plays it in place under the docked player bar
 *   (`startBookInPlace`: once its chapters are in, through the book's own connection);
 *   a book already loaded just plays on (from `at`, or toggles with `toggle`);
 * - with the full player already on top (Up next's sheet over it), every layout starts
 *   in place like a tablet: the open player shows the new book.
 * Resolves once the book is on its way; rejects when it couldn't be fetched, so the
 * caller can say so.
 */
export function usePlayBook() {
  const phone = useLayout() === 'phone';
  const { openBook, openPlayer } = useOpen();
  return async (target: PlayTarget, opts: PlayOptions = {}) => {
    const { connectionId, libraryId, path } = target;
    const { at = {} } = opts;
    const store = usePlayer.getState();
    const loaded = selectBookKey(store) === contentKey(connectionId, libraryId, path);
    // Read at the press, not subscribed: every Library row holds this hook, and a
    // subscription re-rendered them all on every navigation.
    const route = playRoute({
      phone,
      loaded,
      toggle: !!opts.toggle,
      viaBookPage: !!opts.viaBookPage,
      ...navFor(currentNavState(), target),
    });
    switch (route.kind) {
      case 'toggle':
        await store.toggle();
        return;
      case 'player':
        if (route.bookPage) openBook(connectionId, libraryId, path);
        openPlayer(connectionId, libraryId, path, at);
        return;
      case 'play-on':
        if (at.position !== undefined) await store.seekBook(at.position);
        else if (at.track !== undefined) await store.goToTrack(at.track);
        if (!selectIsTransportLive(usePlayer.getState())) await usePlayer.getState().toggle();
        return;
      case 'start':
        await startBookInPlace(target, at);
    }
  };
}
