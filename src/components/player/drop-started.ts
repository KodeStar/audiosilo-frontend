import { contentKey } from '@/lib/content-key';
import { selectBookKey, usePlayer } from '@/playback/store';

import { dropFromQueue } from './queue-drop';

/**
 * A book that was just started leaves Up next (`dropFromQueue`), only once it is the book
 * loaded: a start that failed (its load threw, its place could not be looked up) or that
 * another start took over leaves the queue as it was. `path` is the book's own
 * `rel_path`, as the player holds it; `asked` is the path the start was asked for (a queue
 * entry's own path), dropped too when it differs: an entry that is no longer exactly a
 * book (a part path the server now resolves to the book folder) would otherwise stay
 * queued after it started. Its own module, so `queue-drop` stays free of the player store.
 */
export function dropStartedBook(
  connectionId: string,
  libraryId: number,
  path: string,
  asked?: string,
): void {
  const s = usePlayer.getState();
  if (selectBookKey(s) !== contentKey(connectionId, libraryId, path)) return;
  if (s.snapshot.state === 'error') return;
  const books = [{ library_id: libraryId, path }];
  if (asked && asked !== path) books.push({ library_id: libraryId, path: asked });
  void dropFromQueue(connectionId, books);
}
