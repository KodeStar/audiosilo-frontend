import { router } from 'expo-router';

import type { Book, ChaptersResponse } from '@/api/types';
import { usePlayBook } from '@/components/player/use-play-book';
import { contentKey } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { selectBookKey, selectIsTransportLive, usePlayer } from '@/playback/store';

import type { Jump } from './book-page-model';

/**
 * The book page's two ways to play:
 * - `play()`, the primary button: THE play path (`usePlayBook`, toggling a loaded book in
 *   place, so it never restarts it): a phone opens the full player, a tablet or desktop
 *   plays under the docked bar.
 * - `playAt(jump)`, a chapter row, a timeline tap or a pin: a phone opens the player on
 *   that place (the route applies the jump once, also to the loaded book); a tablet or
 *   desktop seeks the loaded book there (a jump, so the Undo chip follows) and plays on,
 *   or starts this book there under the docked bar.
 * Both resolve once the book is on its way and reject when it can't start, so the caller
 * can say so.
 */
export function usePlayAt(
  connectionId: string,
  libraryId: number,
  /** Undefined while the item loads: then neither does anything. */
  book: Book | undefined,
  chapterData: ChaptersResponse | undefined,
) {
  const phone = useLayout() === 'phone';
  const startBook = usePlayBook();

  const play = async () => {
    if (!book) return;
    await startBook({ connectionId, libraryId, path: book.rel_path }, { toggle: true });
  };

  const playAt = async (jump: Jump) => {
    if (!book) return;
    if (phone) {
      router.push({
        pathname: '/player',
        params: {
          connection: connectionId,
          libraryId: String(libraryId),
          path: book.rel_path,
          ...(jump.position !== undefined ? { position: String(Math.round(jump.position)) } : {}),
          ...(jump.track !== undefined ? { track: String(jump.track) } : {}),
        },
      });
      return;
    }
    const store = usePlayer.getState();
    if (selectBookKey(store) === contentKey(connectionId, libraryId, book.rel_path)) {
      if (jump.position !== undefined) await store.seekBook(jump.position);
      else if (jump.track !== undefined) await store.goToTrack(jump.track);
      if (!selectIsTransportLive(usePlayer.getState())) await usePlayer.getState().toggle();
      return;
    }
    await store.playBook(connectionId, libraryId, book, chapterData, jump.position, jump.track);
  };

  return { play, playAt };
}
