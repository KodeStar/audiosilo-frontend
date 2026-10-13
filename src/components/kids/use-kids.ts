import {
  type QueryObserverResult,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  allProgressQuery,
  collectionQuery,
  collectionsQuery,
  itemQuery,
  librariesQuery,
  qk,
  useLibraryBooks,
  useServerInfo,
} from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { useReachability } from '@/api/reachability';
import type { Book, CollectionDetail } from '@/api/types';
import { statusSignature } from '@/downloads/downloads-view';
import { useDownloads } from '@/downloads/store';
import { connectionsOfProfile, type Profile, useActiveProfile } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import {
  kidsCollections,
  kidsCollectionSections,
  kidsConnectionId,
  kidsContinuePaths,
  kidsDownloads,
  kidsLibrary,
  kidsOfflineScope,
  kidsSectionBooks,
  kidsShelf,
  type KidsSection,
  kidsShelfMode,
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

/**
 * Where kids mode's shelf for `profile` comes from (`kidsShelfMode`): its connection
 * (`kidsConnectionId`), and for a household member on a server with `collections`, the
 * collections the account's owner shares with it (`kidsCollections`, the same cache entry
 * as `useCollections`). Never asked while the kid's connection is signed out
 * (`needsReconnect`): a 401 can't tell, and a grown-up signs them in again first. A server
 * whose /server fails keeps no collections (the one-library view, no wait). The one
 * reading behind kids mode's stories (`useKidsStories`) and the Household card
 * (`useKidsSharedShelf`); the car reads the same rules without React.
 */
function useKidsShelfSource(profile: Profile | null) {
  const all = useSession((s) => s.connections);
  const ids = profile?.connectionIds;
  const connections = useMemo(() => (ids ? connectionsOfProfile(all, ids) : []), [all, ids]);
  const cid = kidsConnectionId(
    connections.map((c) => c.id),
    profile?.kids,
  );
  const connection = connections.find((c) => c.id === cid);
  // '' (not undefined) when there is no connection, so no default connection stands in.
  const client = useOptionalApi(cid ?? '');
  const server = useServerInfo(cid ?? '');
  const caps = server.data?.capabilities;
  const hasCollections = caps ? !!caps.collections : server.isError ? false : undefined;
  const signedOut = !!connection?.needsReconnect;
  const ask = !!connection?.user.managed_by && hasCollections === true && !signedOut;
  const collections = useQuery(collectionsQuery(cid ?? '', ask ? client : null));
  const user = connection?.user;
  const shared = useMemo(
    () => kidsCollections(collections.data ?? [], user),
    [collections.data, user],
  );
  const mode = kidsShelfMode(user, hasCollections, collections.data);
  return { cid, connection, client, signedOut, ask, collections, shared, mode };
}

/** Where kids mode's shelf for a profile comes from, as the Household card needs it
 * (`useKidsSharedShelf`): the collections the account's owner shares, the profile's
 * library pick, or `unknown` (the kid's sign-in there ended, or asking for the shared
 * collections failed), when neither the pick nor its errors mean anything yet. */
export type KidsShelfSource = 'shared' | 'library' | 'unknown';

/**
 * Whether kids mode's shelf for `profile` is the collections its account's owner shares
 * with it (8b-1, D6: `kidsShelfMode`, as `useKidsStories` decides it): then the profile's
 * library pick is not used. `library` while that isn't known yet, and for anyone else.
 * `unknown` while the kid's connection is signed out or the member's collections couldn't
 * be read.
 */
export function useKidsSharedShelf(profile: Profile): KidsShelfSource {
  const { signedOut, mode, ask, collections } = useKidsShelfSource(profile);
  if (signedOut) return 'unknown';
  if (mode === 'collections') return 'shared';
  return ask && collections.isError ? 'unknown' : 'library';
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
  /** The kid's sign-in there ended (a revoked session, a deleted account: a 401, or a
   * server that was reset; `needsReconnect`) and there are no stories to show: only a
   * grown-up can sign them in again, so asking again can't help. */
  | { status: 'signed-out'; serverName: string }
  /** `offline`: the server can't be reached and these are the downloaded stories. `more`:
   * whether the library has more stories than listed so far (`loadMore` asks for them),
   * on their way, or whether asking failed (`retry` asks again). `sections`: the shelf
   * in titled runs (several collections shared by the kid's owner), else absent (one
   * run: `books`). `books` is always every story, in order. `signedOut`: the kid's sign-in
   * ended (as `signed-out`), so these are what the device still has. */
  | {
      status: 'ready';
      books: Book[];
      sections?: KidsSection[];
      offline: boolean;
      more: KidsMore;
      signedOut?: boolean;
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
 * Kids mode's stories: the kid's connection (`kidsConnectionId`), then (`kidsShelfMode`)
 * either
 * - the collections the account's owner shares with it (Phase 8b-1, `kidsCollections`: a
 *   household member, `user.managed_by`, on a server with `collections`), each read whole
 *   (GET /me/collections/{id}), stories in progress first (`kidsCollectionSections`); or,
 *   when there is no such collection (no owner, an older server, a member on "Everything
 *   I can listen to" nobody shares a collection with),
 * - one library (`kidsLibrary`, from GET /libraries, which the server scopes to what the
 *   account may see), the stories in progress first (their items, by `kidsContinuePaths`),
 *   then the library's books page by page (`loadMore` asks for the next one as the grid
 *   scrolls near its end).
 * Offline, the downloaded stories of that connection (`kidsDownloads`, `kidsOfflineScope`).
 * `retry` asks again. A kid whose sign-in there ended sees what the device still has, else
 * `signed-out`.
 */
export function useKidsStories(): {
  stories: KidsStories;
  connectionId: string | null;
  retry: () => void;
  loadMore: () => void;
} {
  const qc = useQueryClient();
  const profile = useKidsProfile();
  const { cid, connection, client, signedOut, ask, collections, shared, mode } =
    useKidsShelfSource(profile);
  const details = useQueries({
    queries: shared.map((c) => collectionQuery(cid ?? '', ask ? client : null, c.id)),
    combine: combineDetails,
  });

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
  // The picked library even while GET /libraries can't be read; every story downloaded on
  // the kid's own account when the shelf is (or may be) collections (`kidsOfflineScope`).
  const offlineLibraryId = cid ? kidsOfflineScope(mode, library, cid, profile?.kids) : null;
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
  const sectionBooks = useMemo(() => kidsSectionBooks(sections), [sections]);

  const retry = () => {
    if (mode !== 'collections') void libraries.refetch();
    if (ask) {
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
  const ready = (
    books: Book[],
    rest: { offline: boolean; more: KidsMore; sections?: KidsSection[] },
  ): KidsStories => ({
    status: 'ready',
    books,
    ...rest,
    signedOut,
  });
  // The server can't give the stories: the downloaded ones, else an error.
  const fallback = (): KidsStories =>
    downloaded.length > 0
      ? ready(downloaded, { offline: true, more: 'none' })
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
    // The server can't say (yet) which view: unreachable, signed out (the collections
    // aren't asked), or the collections list failed.
    stories =
      (librariesFailed && !libraries.data) || collections.isError || signedOut
        ? fallback()
        : { status: 'loading' };
  } else if (mode === 'collections') {
    // Wait for every collection and the progress, so the grid doesn't reorder.
    if (details.loading || progress.isLoading) stories = { status: 'loading' };
    else if (sections.length === 0) {
      stories = details.failed ? fallback() : { status: 'empty', serverName, askGrownUp: true };
    } else {
      stories = ready(sectionBooks, {
        ...(sections.length > 1 ? { sections } : {}),
        offline: false,
        more: details.failed ? 'failed' : 'none',
      });
    }
  } else if (librariesFailed && !libraries.data) stories = fallback();
  else if (libraries.isPending) stories = { status: 'loading' };
  else if (!library) stories = { status: 'empty', serverName };
  // The stories in progress come first: wait for them, so the grid doesn't reorder.
  else if (pages.isPending || progress.isLoading || continuing.loading) {
    stories = { status: 'loading' };
  } else if (pages.isError && shelf.length === 0) stories = fallback();
  else if (shelf.length === 0) stories = { status: 'empty', serverName };
  else stories = ready(shelf, { offline: false, more });
  // Signed out with nothing to show: only a grown-up can help, whatever else went wrong.
  if (signedOut && stories.status !== 'ready' && stories.status !== 'no-connection') {
    stories = { status: 'signed-out', serverName };
  }

  return { stories, connectionId: cid, retry, loadMore };
}
