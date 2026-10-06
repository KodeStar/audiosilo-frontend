import { useApis } from '@/api/provider';
import { contentKey } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { selectBookKey, selectIsTransportLive, usePlayer } from '@/playback/store';

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
 * - a tablet or desktop plays it in place under the docked player bar, once its
 *   chapters are in (the player never starts before them), through the book's own
 *   connection; a book already loaded just plays on (or toggles, with `toggle`).
 * Resolves once the book is on its way; rejects when it couldn't be fetched, so the
 * caller can say so.
 */
export function usePlayBook() {
  const phone = useLayout() === 'phone';
  const { openBook, openPlayer } = useOpen();
  const apis = useApis();
  return async (target: PlayTarget, opts: PlayOptions = {}) => {
    const { connectionId, libraryId, path } = target;
    const store = usePlayer.getState();
    const loaded = selectBookKey(store) === contentKey(connectionId, libraryId, path);
    if (loaded && opts.toggle) {
      await store.toggle();
      return;
    }
    if (phone) {
      if (opts.viaBookPage) openBook(connectionId, libraryId, path);
      openPlayer(connectionId, libraryId, path);
      return;
    }
    if (loaded) {
      if (!selectIsTransportLive(store)) await store.toggle();
      return;
    }
    const api = apis.find((a) => a.connection.id === connectionId)?.client;
    if (!api) return;
    const [book, chapters] = await Promise.all([
      api.item(libraryId, path),
      api.chapters(libraryId, path),
    ]);
    await usePlayer.getState().playBook(connectionId, libraryId, book, chapters);
  };
}
