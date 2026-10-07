import type { ApiClient } from '@/api/client';
import { allProgressQuery, fetchCapabilities, nextBookQuery, queueQuery } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { contentKey } from '@/lib/content-key';

import { resolveNextBook } from './next-book';
import type { UpNextSources } from './up-next-resolver';

/**
 * The real server reads behind `resolveUpNext`, through the shared query cache (the same
 * entries Up next, Home and keep-ahead read). The queue is read fresh: another device may
 * have changed it while this book played. Does not import the playback store.
 */
export function upNextSources(client: ApiClient, cid: string): UpNextSources {
  return {
    capabilities: () => fetchCapabilities(cid, client),
    queue: () => queryClient.fetchQuery({ ...queueQuery(cid, client), staleTime: 0 }),
    finished: () => finishedKeys(client, cid),
    nextBook: (libraryId, path) =>
      queryClient.fetchQuery(nextBookQuery(cid, client, libraryId, path)),
    folderNext: (libraryId, path) => resolveNextBook(client, libraryId, path),
  };
}

/** The `contentKey`s of the books finished on one connection, from its progress rows
 * (read at most a minute old). What plays next and what keep-ahead keeps ready both skip
 * them. */
export async function finishedKeys(client: ApiClient, cid: string): Promise<Set<string>> {
  const rows = await queryClient.fetchQuery({
    ...allProgressQuery(cid, client),
    staleTime: 60_000,
  });
  return new Set(rows.filter((p) => p.finished).map((p) => contentKey(cid, p.library_id, p.path)));
}
