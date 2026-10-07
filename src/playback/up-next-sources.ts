import type { ApiClient } from '@/api/client';
import {
  allProgressQuery,
  fetchCapabilities,
  fetchFailFast,
  nextBookQuery,
  queueQuery,
} from '@/api/hooks';
import { contentKey } from '@/lib/content-key';

import { resolveNextBook } from './next-book';
import type { UpNextSources } from './up-next-resolver';

/**
 * The real server reads behind `resolveUpNext`, through the shared query cache (the same
 * entries Up next, Home and keep-ahead read). The queue is read fresh: another device may
 * have changed it while this book played. Every read settles (`fetchFailFast`): the end
 * of a book can come while the browser is offline or the tab is hidden, and the
 * resolver's fallbacks only help a read that ends. Does not import the playback store.
 */
export function upNextSources(client: ApiClient, cid: string): UpNextSources {
  return {
    capabilities: () => fetchCapabilities(cid, client),
    queue: () => fetchFailFast({ ...queueQuery(cid, client), staleTime: 0 }),
    finished: () => finishedKeys(client, cid),
    nextBook: (libraryId, path) => fetchFailFast(nextBookQuery(cid, client, libraryId, path)),
    folderNext: (libraryId, path) => resolveNextBook(client, libraryId, path),
  };
}

/** The `contentKey`s of the books finished on one connection, from its progress rows
 * (read at most a minute old, and never held for the browser: `fetchFailFast`). What
 * plays next and what keep-ahead keeps ready both skip them. */
export async function finishedKeys(client: ApiClient, cid: string): Promise<Set<string>> {
  const rows = await fetchFailFast({
    ...allProgressQuery(cid, client),
    staleTime: 60_000,
  });
  return new Set(rows.filter((p) => p.finished).map((p) => contentKey(cid, p.library_id, p.path)));
}
