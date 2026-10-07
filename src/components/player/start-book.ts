import { resolveClient } from '@/api/connection-clients';
import { chaptersQuery, itemQuery } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { usePlayer } from '@/playback/store';

import type { PlayTarget } from './use-play-book';

/**
 * Start a book WITHOUT opening any screen: its item and chapters through the query
 * cache (the player never starts before its chapters), then the store's `playBook`,
 * which resumes from the saved place. Framework-free, so the end-of-book flow can use it
 * while the app is in the background, where presenting the player modal is not
 * possible (iOS cannot present a view controller from the background; the app came
 * back to a black screen). Resolves `false` when the book's connection is gone; rejects
 * when the book could not be fetched.
 */
export async function startBookInPlace(target: PlayTarget): Promise<boolean> {
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
  await usePlayer.getState().playBook(connectionId, libraryId, book, chapters);
  return true;
}
