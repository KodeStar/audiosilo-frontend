import {
  type QueryObserverResult,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  allProgressQuery,
  itemQuery,
  librariesQuery,
  qk,
  useLibraryBooks,
  useServerInfo,
} from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { useReachability } from '@/api/reachability';
import type { Book, CollectionDetail, Library } from '@/api/types';
import { statusSignature } from '@/downloads/downloads-view';
import { useDownloads } from '@/downloads/store';
import { type Profile, useActiveProfile, useProfileConnections } from '@/stores/profiles';

import {
  kidsCollections,
  kidsCollectionSections,
  kidsConnectionId,
  kidsContinuePaths,
  kidsDownloads,
  kidsLibrary,
  kidsOfflineLibraryId,
  kidsSectionBooks,
  kidsShelf,
  type KidsSection,
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
  /** The kid's account sees no library, or the library has no books; `askGrownUp`: the
   * collections their owner shares hold no stories yet. */
  | { status: 'empty'; serverName: string; askGrownUp?: boolean }
  /** The server can't be reached and nothing is downloaded. */
  | { status: 'error'; serverName: string; offline: boolean }
  /** `offline`: the server can't be reached and these are the downloaded stories. `more`:
   * whether the library has more stories than listed so far (`loadMore` asks for them),
   * on their way, or whether asking failed (`retry` asks again). `sections`: the shelf
   * in titled runs (several collections shared by the kid's owner), else absent (one
   * run: `books`). `books` is always every story, in order. */
  | {
      status: 'ready';
      books: Book[];
      sections?: KidsSection[];
      offline: boolean;
      more: KidsMore;
    };

export type KidsMore = 'none' | 'available' | 'loading' | 'failed';

/** How long an in-progress story's item stays fresh (as the series page's rails). */
const ITEM_STALE_MS = 5 * 60_000;

/** The shared collections' answers, in order (undefined while unread), and whether any is
 * still on its way or failed. Module-level, so the combined answer is the same object until
 * a result changes. */
function combineDetails(results: QueryObserverResult<CollectionDetail>[]) {
  return {
    details: results.map((r) => r.data),
    loading: results.some((r) => r.isPending && r.fetchStatus !== 'idle'),
    failed: results.some((r) => r.isError),
  };
}

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
 * Kids mode's stories: the kid's connection (`kidsConnectionId`), then either
 * - the collections the account's owner shares with it (Phase 8b-1, `kidsCollections`: a
 *   household member, `user.managed_by`, on a server with `collections`), each read whole
 *   (GET /me/collections/{id}), stories in progress first (`kidsCollectionSections`); or,
 *   when there is no such collection (no owner, an older server, a member on "Everything
 *   I can listen to" nobody shares a collection with),
 * - one library (`kidsLibrary`, from GET /libraries, which the server scopes to what the
 *   account may see), the stories in progress first (their items, by `kidsContinuePaths`),
 *   then the library's books page by page (`loadMore` asks for the next one as the grid
 *   scrolls near its end).
 * Offline, the downloaded stories of that connection (`kidsDownloads`). `retry` asks again.
 */
export function useKidsStories(): {
  stories: KidsStories;
  connectionId: string | null;
  library: Library | null;
  retry: () => void;
  loadMore: () => void;
} {
  const qc = useQueryClient();
  const profile = useKidsProfile();
  const connections = useProfileConnections();
  const cid = kidsConnectionId(
    connections.map((c) => c.id),
    profile?.kids,
  );
  const connection = connections.find((c) => c.id === cid);
  // '' (not undefined) when there is no connection, so no default connection stands in.
  const client = useOptionalApi(cid ?? '');
  const server = useServerInfo(cid ?? '');
  // The owner's shared collections, asked for only for a household member on a server
  // that keeps collections (the same cache entry as `useCollections`).
  const managed = !!connection?.user.managed_by;
  const caps = server.data?.capabilities;
  // undefined while not known; a server whose /server fails is no wait (the library view).
  const hasCollections = caps ? !!caps.collections : server.isError ? false : undefined;
  const askCollections = managed && hasCollections === true && !!client;
  const collections = useQuery({
    queryKey: qk.collections(cid ?? ''),
    queryFn: askCollections && client ? ({ signal }) => client.collections(signal) : skipToken,
  });
  const shared = useMemo(
    () => kidsCollections(collections.data ?? [], connection?.user),
    [collections.data, connection?.user],
  );
  const details = useQueries({
    queries: shared.map((c) => ({
      queryKey: qk.collection(cid ?? '', c.id),
      queryFn:
        askCollections && client
          ? ({ signal }: { signal: AbortSignal }) => client.collection(c.id, signal)
          : skipToken,
    })),
    combine: combineDetails,
  });
  // Which view: the collections, the one library, or not known yet.
  const mode: 'collections' | 'library' | 'unknown' =
    !managed || hasCollections === false
      ? 'library'
      : hasCollections === undefined || collections.data === undefined
        ? 'unknown'
        : shared.length > 0
          ? 'collections'
          : 'library';

  const libraries = useQuery(librariesQuery(cid ?? '', client));
  const library = cid && libraries.data ? kidsLibrary(libraries.data, cid, profile?.kids) : null;
  const pages = useLibraryBooks(library?.id ?? 0, {}, cid ?? '', {
    enabled: !!library && mode === 'library',
  });
  const listed = useMemo(() => pages.data?.pages.flatMap((p) => p.books) ?? [], [pages.data]);
  const progress = useQuery(allProgressQuery(cid ?? '', client));
  const continuePaths = useMemo(
    () => (library && mode === 'library' ? kidsContinuePaths(progress.data ?? [], library.id) : []),
    [progress.data, library, mode],
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
  // The picked library even while GET /libraries can't be read (`kidsOfflineLibraryId`);
  // every story downloaded on the kid's own account when the shelf is collections (they
  // can span libraries).
  const offlineLibraryId =
    cid && mode !== 'collections' ? kidsOfflineLibraryId(library, cid, profile?.kids) : null;
  const downloaded = useMemo(
    () => (cid ? kidsDownloads(useDownloads.getState().entries, cid, offlineLibraryId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on the signature
    [downloadsSig, cid, offlineLibraryId],
  );
  const shelf = useMemo(() => kidsShelf(continuing.books, listed), [continuing.books, listed]);
  const sections = useMemo(
    () =>
      mode === 'collections'
        ? kidsCollectionSections(shared, details.details, progress.data ?? [])
        : [],
    [mode, shared, details.details, progress.data],
  );

  const retry = () => {
    void libraries.refetch();
    if (askCollections) {
      void collections.refetch();
      for (const c of shared) {
        void qc.refetchQueries({ queryKey: qk.collection(cid ?? '', c.id), type: 'all' });
      }
    }
    if (library && mode === 'library') void (pages.data ? pages.fetchNextPage() : pages.refetch());
    void progress.refetch();
  };
  const loadMore = () => {
    // Not after a failed page: the footer's Try again asks again (`retry`), so a scroll
    // near the end can't send the same failing request over and over.
    if (mode !== 'library') return;
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
  else if (mode === 'unknown') {
    // The server can't say (yet) which view: unreachable, or the collections list failed.
    stories =
      (librariesFailed && !libraries.data) || collections.isError
        ? fallback()
        : { status: 'loading' };
  } else if (mode === 'collections') {
    // Wait for every collection and the progress, so the grid doesn't reorder.
    if (details.loading || progress.isLoading) stories = { status: 'loading' };
    else if (sections.length === 0) {
      stories = details.failed ? fallback() : { status: 'empty', serverName, askGrownUp: true };
    } else {
      stories = {
        status: 'ready',
        books: kidsSectionBooks(sections),
        ...(sections.length > 1 ? { sections } : {}),
        offline: false,
        more: details.failed ? 'failed' : 'none',
      };
    }
  } else if (librariesFailed && !libraries.data) stories = fallback();
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
