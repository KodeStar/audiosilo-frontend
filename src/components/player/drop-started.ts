import { sameConnection } from '@/lib/connection-id';
import { usePlayer } from '@/playback/store';
import { entryHolds } from '@/playback/up-next-resolver';

import { dropFromQueue } from './queue-drop';

/**
 * A book that was just started leaves Up next (`dropFromQueue`), only once it is the book
 * loaded: a start that failed (its load threw, its place could not be looked up) or that
 * another start took over leaves the queue as it was. `path` is the book's own `rel_path`,
 * as the player holds it, and must be the loaded book; undefined for a queue entry with no
 * resolved book, whose `asked` path may then be a part of the loaded book (a known book
 * inside that folder is a separate one). `asked` is the path the start was asked for (a
 * queue entry's own path), dropped too when it differs: an entry that is no longer exactly
 * a book (a part path the server now resolves to the book folder) would otherwise stay
 * queued after it started. Its own module, so `queue-drop` stays free of the player store.
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
  const books = [{ library_id: libraryId, path: loaded.path }];
  const matches =
    path === undefined
      ? asked !== undefined && entryHolds(books[0], libraryId, asked)
      : path === loaded.path;
  if (!matches) return;
  if (asked && asked !== loaded.path) books.push({ library_id: libraryId, path: asked });
  void dropFromQueue(connectionId, books);
}
