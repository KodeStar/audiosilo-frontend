import { sameConnection } from '@/lib/connection-id';
import { usePlayer } from '@/playback/store';

import { dropFromQueue } from './queue-drop';

/**
 * A book that was just started leaves Up next (`dropFromQueue`), only once it is the book
 * loaded: a start that failed (its load threw, its place could not be looked up) or that
 * another start took over leaves the queue as it was. `path` is the book's own
 * `rel_path`, as the player holds it; `asked` is the path the start was asked for (a queue
 * entry's own path), dropped too when it differs: an entry that is no longer exactly a
 * book (a part path the server now resolves to the book folder) would otherwise stay
 * queued after it started. With no resolved book on a queue entry, its path may
 * be a part of the loaded book. A known book inside that folder is separate. Its own module, so `queue-drop` stays free of the player store.
 */
export function dropStartedBook(
  connectionId: string,
  libraryId: number,
  path: string | undefined,
  asked?: string,
): void {
  const { nowPlaying: loaded, snapshot } = usePlayer.getState();
  if (
    !loaded ||
    !sameConnection(loaded.connectionId, connectionId) ||
    loaded.libraryId !== libraryId ||
    snapshot.state === 'error'
  )
    return;
  const matches =
    path === undefined
      ? asked === loaded.path || asked?.startsWith(`${loaded.path}/`)
      : path === loaded.path;
  if (!matches) return;
  const books = [{ library_id: libraryId, path: loaded.path }];
  if (asked && asked !== loaded.path) books.push({ library_id: libraryId, path: asked });
  void dropFromQueue(connectionId, books);
}
