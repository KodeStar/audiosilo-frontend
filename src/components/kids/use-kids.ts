import { type QueryObserverResult, useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { allProgressQuery, itemQuery, librariesQuery, useLibraryBooks } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { useReachability } from '@/api/reachability';
import type { Book, Library } from '@/api/types';
import { statusSignature } from '@/downloads/downloads-view';
import { useDownloads } from '@/downloads/store';
import { type Profile, useActiveProfile, useProfileConnections } from '@/stores/profiles';

import {
  kidsConnectionId,
  kidsContinuePaths,
  kidsDownloads,
  kidsLibrary,
  kidsOfflineLibraryId,
  kidsShelf,
} from './kids-model';

/** The active profile when it is in kids mode, else null. */
export function useKidsProfile(): Profile | null {
  const profile = useActiveProfile();
  return profile?.kids ? profile : null;
}

/** Whether the active profile is in kids mode (the gate keeps it on `/kids`). */
export function useKidsActive(): boolean {
  return useKidsProfile() !== null;
}

/** What kids mode's story grid shows. */
export type KidsStories =
  | { status: 'loading' }
  /** The profile holds no connection (only for a moment: such a profile is deleted). */
  | { status: 'no-connection' }
  /** The kid's account sees no library, or the library has no books. */
  | { status: 'empty'; serverName: string }
  /** The server can't be reached and nothing is downloaded. */
  | { status: 'error'; serverName: string; offline: boolean }
  /** `offline`: the server can't be reached and these are the downloaded stories. `more`:
   * whether the library has more stories than listed so far (`loadMore` asks for them),
   * on their way, or whether asking failed (`retry` asks again). */
  | { status: 'ready'; books: Book[]; offline: boolean; more: KidsMore };

export type KidsMore = 'none' | 'available' | 'loading' | 'failed';

/** How long an in-progress story's item stays fresh (as the series page's rails). */
const ITEM_STALE_MS = 5 * 60_000;

/** The in-progress stories' items, in order (one that failed, say a book no longer in the
 * library, left out), and whether any is still on its way. Module-level, so the combined
 * answer is the same object until a result changes. */
function combineContinuing(results: QueryObserverResult<Book>[]) {
  return {
    books: results.flatMap((r) => (r.data ? [r.data] : [])),
    loading: results.some((r) => r.isLoading),
  };
}

/**
 * Kids mode's stories: the kid's connection (`kidsConnectionId`), its library
 * (`kidsLibrary`, from GET /libraries, which the server scopes to what the account may
 * see), the stories in progress first (their items, by `kidsContinuePaths`), then the
 * library's books page by page (`loadMore` asks for the next one as the grid scrolls
 * near its end). Offline, the downloaded stories of that connection (`kidsDownloads`).
 * `retry` asks again.
 */
export function useKidsStories(): {
  stories: KidsStories;
  connectionId: string | null;
  library: Library | null;
  retry: () => void;
  loadMore: () => void;
} {
  const profile = useKidsProfile();
  const connections = useProfileConnections();
  const cid = kidsConnectionId(
    connections.map((c) => c.id),
    profile?.kids,
  );
  const connection = connections.find((c) => c.id === cid);
  // '' (not undefined) when there is no connection, so no default connection stands in.
  const client = useOptionalApi(cid ?? '');
  const libraries = useQuery(librariesQuery(cid ?? '', client));
  const library = cid && libraries.data ? kidsLibrary(libraries.data, cid, profile?.kids) : null;
  const pages = useLibraryBooks(library?.id ?? 0, {}, cid ?? '', { enabled: !!library });
  const listed = useMemo(() => pages.data?.pages.flatMap((p) => p.books) ?? [], [pages.data]);
  const progress = useQuery(allProgressQuery(cid ?? '', client));
  const continuePaths = useMemo(
    () => (library ? kidsContinuePaths(progress.data ?? [], library.id) : []),
    [progress.data, library],
  );
  const continuing = useQueries({
    queries: continuePaths.map((path) => ({
      ...itemQuery(cid ?? '', client, library?.id ?? 0, path),
      staleTime: ITEM_STALE_MS,
    })),
    combine: combineContinuing,
  });
  const offline = useReachability((s) => (cid ? s.online[cid] === false : false));
  // Re-read when a download lands or goes, never on a progress tick (which would
  // re-render the whole kids screen several times a second while one downloads).
  const downloadsSig = useDownloads((s) => statusSignature(s.entries));
  // The picked library even while GET /libraries can't be read (`kidsOfflineLibraryId`).
  const offlineLibraryId = cid ? kidsOfflineLibraryId(library, cid, profile?.kids) : null;
  const downloaded = useMemo(
    () => (cid ? kidsDownloads(useDownloads.getState().entries, cid, offlineLibraryId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on the signature
    [downloadsSig, cid, offlineLibraryId],
  );
  const shelf = useMemo(() => kidsShelf(continuing.books, listed), [continuing.books, listed]);

  const retry = () => {
    void libraries.refetch();
    if (library) void (pages.data ? pages.fetchNextPage() : pages.refetch());
    void progress.refetch();
  };
  const loadMore = () => {
    // Not after a failed page: the footer's Try again asks again (`retry`), so a scroll
    // near the end can't send the same failing request over and over.
    if (pages.hasNextPage && !pages.isFetching && !pages.isFetchNextPageError) {
      void pages.fetchNextPage();
    }
  };

  const serverName = connection?.name ?? '';
  // The server can't give the stories: the downloaded ones, else an error.
  const fallback = (): KidsStories =>
    downloaded.length > 0
      ? { status: 'ready', books: downloaded, offline: true, more: 'none' }
      : { status: 'error', serverName, offline };
  const more: KidsMore = !pages.hasNextPage
    ? 'none'
    : pages.isFetchNextPageError
      ? 'failed'
      : pages.isFetchingNextPage
        ? 'loading'
        : 'available';
  let stories: KidsStories;
  // Paused (React Query's offline state) counts as unreachable, as does a failed read.
  const librariesFailed =
    libraries.isError || (libraries.isPending && libraries.fetchStatus === 'paused');
  if (!cid) stories = { status: 'no-connection' };
  // The streamed stories wouldn't play: show the ones on this device.
  else if (offline && downloaded.length > 0) stories = fallback();
  else if (librariesFailed && !libraries.data) stories = fallback();
  else if (libraries.isPending) stories = { status: 'loading' };
  else if (!library) stories = { status: 'empty', serverName };
  // The stories in progress come first: wait for them, so the grid doesn't reorder.
  else if (pages.isPending || progress.isLoading || continuing.loading) {
    stories = { status: 'loading' };
  } else if (pages.isError && shelf.length === 0) stories = fallback();
  else if (shelf.length === 0) stories = { status: 'empty', serverName };
  else stories = { status: 'ready', books: shelf, offline: false, more };

  return { stories, connectionId: cid, library, retry, loadMore };
}
