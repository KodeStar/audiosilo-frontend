import type { ApiClient } from '@/api/client';
import { allProgressQuery, nextBookQuery, queueQuery, serverInfoQuery } from '@/api/hooks';
import { queryClient } from '@/api/provider';

import { resolveNextBook } from './next-book';
import { finishedKey, type UpNextSources } from './up-next-resolver';

/**
 * The real server reads behind `resolveUpNext`, through the shared query cache (the same
 * entries Up next, Home and keep-ahead read). The queue is read fresh: another device may
 * have changed it while this book played. Does not import the playback store.
 */
export function upNextSources(client: ApiClient, cid: string): UpNextSources {
  return {
    capabilities: async () =>
      (await queryClient.fetchQuery(serverInfoQuery(cid, client))).capabilities,
    queue: () => queryClient.fetchQuery({ ...queueQuery(cid, client), staleTime: 0 }),
    finished: async () => {
      const rows = await queryClient.fetchQuery({
        ...allProgressQuery(cid, client),
        staleTime: 60_000,
      });
      return new Set(rows.filter((p) => p.finished).map((p) => finishedKey(p.library_id, p.path)));
    },
    nextBook: (libraryId, path) =>
      queryClient.fetchQuery(nextBookQuery(cid, client, libraryId, path)),
    folderNext: (libraryId, path) => resolveNextBook(client, libraryId, path),
  };
}
