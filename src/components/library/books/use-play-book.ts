import { useApiRegistry } from '@/api/provider';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { selectIsPlaying, usePlayer } from '@/playback/store';

/**
 * Play (or resume) a book from a list, through the path Home's progress cards use: on a
 * phone the full player opens over the book page (so closing it lands there); on tablet
 * and desktop it starts in place under the docked player once its chapters are in (the
 * player never starts before them). A book already loaded just plays.
 */
export function usePlayBook() {
  const phone = useLayout() === 'phone';
  const { openBook, openPlayer } = useOpen();
  const registry = useApiRegistry();
  return async (connectionId: string, libraryId: number, path: string) => {
    if (phone) {
      openBook(connectionId, libraryId, path);
      openPlayer(connectionId, libraryId, path);
      return;
    }
    const player = usePlayer.getState();
    const np = player.nowPlaying;
    if (np?.connectionId === connectionId && np.libraryId === libraryId && np.path === path) {
      if (!selectIsPlaying(player)) await player.toggle();
      return;
    }
    const api = registry.clients.get(connectionId);
    if (!api) return;
    const [book, chapters] = await Promise.all([
      api.item(libraryId, path),
      api.chapters(libraryId, path),
    ]);
    await usePlayer.getState().playBook(connectionId, libraryId, book, chapters);
  };
}
