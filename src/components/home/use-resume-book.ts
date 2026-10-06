import { useApis } from '@/api/provider';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { usePlayer } from '@/playback/store';

import type { BookAt } from './home-model';

/**
 * Resume a book the way Home always has (the old ProgressCard's path): the book that
 * is already loaded toggles in place; otherwise a phone opens the book page with the
 * full player over it (closing the player lands on the book, not Home), and a tablet or
 * desktop starts it inline under the docked player, through the book's own connection.
 */
export function useResumeBook() {
  const apis = useApis();
  const phone = useLayout() === 'phone';
  const { openBook, openPlayer } = useOpen();
  return async (at: BookAt) => {
    const player = usePlayer.getState();
    const np = player.nowPlaying;
    if (
      np?.connectionId === at.connectionId &&
      np.libraryId === at.libraryId &&
      np.path === at.path
    ) {
      await player.toggle();
      return;
    }
    if (phone) {
      openBook(at.connectionId, at.libraryId, at.path);
      openPlayer(at.connectionId, at.libraryId, at.path);
      return;
    }
    const api = apis.find((a) => a.connection.id === at.connectionId)?.client;
    if (!api) return;
    const [book, chapterData] = await Promise.all([
      api.item(at.libraryId, at.path),
      api.chapters(at.libraryId, at.path),
    ]);
    await usePlayer.getState().playBook(at.connectionId, at.libraryId, book, chapterData);
  };
}
