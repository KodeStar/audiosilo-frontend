import { contentKey } from '@/lib/content-key';
import { selectBookKey, usePlayer } from '@/playback/store';

import { dropFromQueue } from './queue-drop';

/**
 * A book that was just started leaves Up next (`dropFromQueue`), only once it is the book
 * loaded: a start that failed (its load threw, its place could not be looked up) or that
 * another start took over leaves the queue as it was. `path` is the book's own
 * `rel_path`, as the player holds it. Its own module, so `queue-drop` stays free of the
 * player store.
 */
export function dropStartedBook(connectionId: string, libraryId: number, path: string): void {
  const s = usePlayer.getState();
  if (selectBookKey(s) !== contentKey(connectionId, libraryId, path)) return;
  if (s.snapshot.state === 'error') return;
  void dropFromQueue(connectionId, [{ library_id: libraryId, path }]);
}
