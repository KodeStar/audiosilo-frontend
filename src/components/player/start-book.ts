import { resolveClient } from '@/api/connection-clients';
import { chaptersQuery, itemQuery } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { usePlayer } from '@/playback/store';

import type { PlayTarget } from './use-play-book';

/** Where `startBookInPlace` starts a book, when not from its saved place. */
export type StartOptions = {
  /** Whole-book seconds to start at (lowers the resume floor there, so the start's own
   * saves are not refused as a slip). */
  position?: number;
  /** The speed to play at: an explicit `position` skips the resume lookup, which is
   * what restores a book's saved speed, so a caller that has it passes it. */
  speed?: number;
};

/**
 * Start a book WITHOUT opening any screen: its item and chapters through the query
 * cache (the player never starts before its chapters; a book whose page is open starts
 * without asking again), then the store's `playBook`, which resumes from the saved place
 * unless `opts.position` says where. The one way a book starts outside the player route:
 * a browse surface's play button (`usePlayBook`), Previously on's resume, and the end of
 * a book (`advanceTo`), which can run while the app is in the background, where
 * presenting the player modal is not possible (iOS cannot present a view controller from
 * the background; the app came back to a black screen). Resolves `false` when the
 * book's connection is gone; rejects when the book could not be fetched.
 */
export async function startBookInPlace(
  target: PlayTarget,
  opts: StartOptions = {},
): Promise<boolean> {
  const { connectionId, libraryId, path } = target;
  const client = resolveClient(connectionId);
  if (!client) return false;
  const [book, chapters] = await Promise.all([
    queryClient.fetchQuery({
      ...itemQuery(connectionId, client, libraryId, path),
      staleTime: 30_000,
    }),
    queryClient.fetchQuery({
      ...chaptersQuery(connectionId, client, libraryId, path),
      staleTime: 30_000,
    }),
  ]);
  await usePlayer.getState().playBook(connectionId, libraryId, book, chapters, opts.position);
  if (opts.speed && opts.speed > 0) await usePlayer.getState().setRate(opts.speed);
  return true;
}
