import {
  type DefaultError,
  type FetchQueryOptions,
  infiniteQueryOptions,
  type InfiniteData,
  MutationObserver,
  type Query,
  type QueryClient,
  type QueryKey,
  queryOptions,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import {
  bridgePollInterval,
  estimatePollInterval,
  latestDone,
  midRunCheckpoint,
  SIDECARS_GENERATE,
} from '@/lib/bridge-jobs';
import { afterPaint } from '@/lib/after-paint';
import { byPosition } from '@/lib/by-position';
import { parseConnectionId, serverIdOf } from '@/lib/connection-id';
import { contentKey } from '@/lib/content-key';
import { bookDedupKey, dedupBooks, type MergedBook, type SourcedBook } from '@/lib/dedup';
import { isPodcastLibrary } from '@/lib/library-kind';
import { parentPath } from '@/lib/paths';
import {
  FOLLOW_REQUEST_POLL_MS,
  isOpenRequest,
  libraryRequests,
  requestsDone,
} from '@/lib/podcast-requests';
import { getDeviceId, mirroredProgress, saveProgress } from '@/playback/progress-sync';
import { lookupReadingPlace } from '@/reader/reading-progress';
import { onConnectionRemoved, useSession } from '@/stores/session';

import {
  ApiError,
  isPlainSeriesQuery,
  type ApiClient,
  type BookListQuery,
  type BookMetaOptions,
} from './client';
import { resolveClient } from './connection-clients';
import { queryClient, useApi, useApis, useCid, useOptionalApi } from './provider';
import { noteFailure } from './reachability';
import type {
  AddMemberBody,
  Book,
  BookMeta,
  Bookmark,
  BookmarkLabel,
  BookmarkPatch,
  BookRef,
  BridgeEstimate,
  BridgeJob,
  BridgeJobRequest,
  Capabilities,
  ChaptersResponse,
  Collection,
  CollectionDetail,
  CollectionInput,
  CollectionPatch,
  Favourite,
  HistoryEntry,
  HouseholdMember,
  HouseholdMembers,
  HouseListening,
  Library,
  ListeningGoalStatus,
  MyBookmark,
  MyNote,
  Note,
  NotePatch,
  Page,
  PageQuery,
  PodcastEpisodeOrder,
  PodcastEpisodePage,
  PodcastFetchStatus,
  PodcastShow,
  MyPodcasts,
  PodcastDiscoveryProvider,
  PodcastFollowResult,
  Progress,
  ProgressEdit,
  Rating,
  RatingValue,
  ServerInfo,
  StatsRange,
  UpdateMemberBody,
} from './types';

/** Centralized query keys so mutations can invalidate precisely. Every key leads with
 * the connection id (`cid`) so two servers with the same (libraryId, path) never share
 * a cache entry; the shape is unified with the cross-connection fan-out hooks below so
 * the single- and multi-server views share one cache. */
export const qk = {
  server: (cid: string) => ['server', cid] as const,
  libraries: (cid: string) => ['libraries', cid] as const,
  browse: (cid: string, lib: number, path: string) => ['browse', cid, lib, path] as const,
  item: (cid: string, lib: number, path: string) => ['item', cid, lib, path] as const,
  chapters: (cid: string, lib: number, path: string) => ['chapters', cid, lib, path] as const,
  /** A book's /meta envelope. Each request variant (`include=previous`,
   * `spoilers=hide`) answers differently, so it gets its own entry, under the plain
   * key as a prefix (invalidating that reaches every variant). */
  bookMeta: (cid: string, lib: number, path: string, opts?: BookMetaOptions) =>
    opts?.includePrevious || opts?.hideSpoilers
      ? ([
          'bookMeta',
          cid,
          lib,
          path,
          { previous: !!opts.includePrevious, hide: !!opts.hideSpoilers },
        ] as const)
      : (['bookMeta', cid, lib, path] as const),
  metaWork: (cid: string, workId: string) => ['metaWork', cid, workId] as const,
  authors: (cid: string, lib: number) => ['authors', cid, lib] as const,
  narrators: (cid: string, lib: number) => ['narrators', cid, lib] as const,
  /** `memberships`: counted in every series a book is in (`series_memberships`). */
  seriesList: (cid: string, lib: number, memberships: boolean) =>
    ['seriesList', cid, lib, { memberships }] as const,
  libraryBooks: (cid: string, lib: number, query: BookListQuery) =>
    ['libraryBooks', cid, lib, query] as const,
  nextBook: (cid: string, lib: number, path: string) => ['nextBook', cid, lib, path] as const,
  allProgress: (cid: string) => ['progress', 'all', cid] as const,
  progress: (cid: string, lib: number, path: string) => ['progress', cid, lib, path] as const,
  /** Where the ebook reader opens a book (`useReadingPlace`). */
  readingPlace: (cid: string, lib: number, path: string) =>
    ['readingPlace', cid, lib, path] as const,
  bookmarks: (cid: string, lib: number, path: string) => ['bookmarks', cid, lib, path] as const,
  notes: (cid: string, lib: number, path: string) => ['notes', cid, lib, path] as const,
  history: (cid: string, lib: number, path: string) => ['history', cid, lib, path] as const,
  /** Prefix matching every history key of a connection (invalidation), the
   * across-books list (`myHistory`) included. */
  historyAll: (cid: string) => ['history', cid] as const,
  /** The caller's listening across books (`myHistoryQuery`, an infinite query), under
   * `historyAll` so a recorded span refreshes it. */
  myHistory: (cid: string) => ['history', cid, 'me'] as const,
  /** The caller's bookmarks across books (`myBookmarksQuery`, an infinite query). */
  myBookmarks: (cid: string) => ['myBookmarks', cid] as const,
  /** The caller's notes across books (`myNotesQuery`, an infinite query). */
  myNotes: (cid: string) => ['myNotes', cid] as const,
  favourites: (connectionId: string) => ['favourites', connectionId] as const,
  apiKeys: (cid: string) => ['apiKeys', cid] as const,
  search: (cid: string, q: string) => ['search', cid, q] as const,
  recent: (cid: string, limit: number) => ['books', 'recent', cid, limit] as const,
  copies: (cid: string, key: string) => ['copies', cid, key] as const,
  // User state (Phase 1b), one capability flag each (see the hooks below).
  queue: (cid: string) => ['queue', cid] as const,
  collections: (cid: string) => ['collections', cid] as const,
  collection: (cid: string, id: number) => ['collection', cid, id] as const,
  /** Prefix matching every collection detail of a connection (invalidation). */
  collectionAll: (cid: string) => ['collection', cid] as const,
  shareTargets: (cid: string) => ['shareTargets', cid] as const,
  rating: (cid: string, lib: number, path: string) => ['rating', cid, lib, path] as const,
  myRatings: (cid: string) => ['myRatings', cid] as const,
  myStats: (cid: string, range: StatsRange) => ['myStats', cid, range] as const,
  /** Prefix matching every `myStats` range of a connection (invalidation). */
  myStatsAll: (cid: string) => ['myStats', cid] as const,
  /** The past years with a story, from the year before `current` back (Year in listening;
   * outside `myStats` so its invalidation doesn't refetch every probed year). */
  storyYears: (cid: string, current: number) => ['storyYears', cid, current] as const,
  myListening: (cid: string, range: StatsRange) => ['myListening', cid, range] as const,
  listeningGoal: (cid: string) => ['listeningGoal', cid] as const,
  myDevices: (cid: string) => ['myDevices', cid] as const,
  // Home and away addresses, capability `addresses`.
  addresses: (cid: string) => ['addresses', cid] as const,
  // Listening in the house, capability `household` (player redesign Phase 8).
  household: (cid: string) => ['household', cid] as const,
  houseListening: (cid: string) => ['houseListening', cid] as const,
  // Household members, capability `household_members` (player redesign Phase 8b-1).
  householdMembers: (cid: string) => ['householdMembers', cid] as const,
  memberDevices: (cid: string, id: number) => ['memberDevices', cid, id] as const,
  /** Prefix matching every member's devices on a connection (invalidation). */
  memberDevicesAll: (cid: string) => ['memberDevices', cid] as const,
  /** Prefix matching every connection's progress list (refetch on Home). */
  allProgressAll: () => ['progress', 'all'] as const,
  /** Prefix matching every connection's recently added list. */
  recentAll: () => ['books', 'recent'] as const,
  /** The car's Library tab: a library's newest books, one page (`src/car`). */
  carLibrary: (cid: string, lib: number) => ['car', 'library', cid, lib] as const,
  // The Bridge, capability `bridge` (admin only; Bridge Phase 1a).
  /** A book's Bridge jobs, by its own path (`rel_path`). */
  bridgeJobs: (cid: string, lib: number, path: string) => ['bridgeJobs', cid, lib, path] as const,
  /** What generating characters and recaps for a book would take. */
  bridgeEstimate: (cid: string, lib: number, path: string) =>
    ['bridgeEstimate', cid, lib, path] as const,
  // Podcasts (Bridge Phase 2d-1): reads are core, Follow is capability `podcasts`, the
  // fetch status `podcast_fetch`.
  /** A podcast library's shows. */
  podcastShows: (cid: string, lib: number) => ['podcastShows', cid, lib] as const,
  /** A show's episodes in one order (`usePodcastEpisodes`, an infinite query). */
  podcastEpisodes: (cid: string, lib: number, show: string, order: PodcastEpisodeOrder) =>
    ['podcastEpisodes', cid, lib, show, order] as const,
  /** Prefix matching every episode list in a podcast library (every show's). */
  podcastEpisodesOfLibrary: (cid: string, lib: number) => ['podcastEpisodes', cid, lib] as const,
  /** Prefix matching every episode list of a show (both orders, Home's latest). */
  podcastEpisodesOfShow: (cid: string, lib: number, show: string) =>
    ['podcastEpisodes', cid, lib, show] as const,
  /** A show's newest `limit` episodes, one page (Home's New episodes), under the show's
   * prefix ('latest' never matches an order's key). */
  latestEpisodes: (cid: string, lib: number, show: string, limit: number) =>
    ['podcastEpisodes', cid, lib, show, 'latest', limit] as const,
  /** The shows the caller follows across the server's podcast libraries. */
  myPodcasts: (cid: string) => ['myPodcasts', cid] as const,
  /** An episode's on-demand fetch status (the episode-fetch controller seeds it). */
  podcastFetch: (cid: string, lib: number, path: string) =>
    ['podcastFetch', cid, lib, path] as const,
  // Finding shows (Bridge Phase 2d-2), capability `podcast_discovery`.
  /** The directories the server can search. */
  discoveryProviders: (cid: string) => ['discoveryProviders', cid] as const,
  /** One directory search: its provider, cleaned text, country and limit (the server's
   * own cache key), so an unchanged repeat reuses the held results. */
  discoverySearch: (
    cid: string,
    provider: string,
    q: string,
    country: string | null,
    limit: number,
  ) => ['discoverySearch', cid, provider, q, country, limit] as const,
};

/** Whether a query key is a connection's Up next queue (`qk.queue`). */
export const isQueueKey = (key: readonly unknown[]): boolean => key[0] === 'queue';

/** Whether a query key is a connection's whole progress list (`qk.allProgress`). */
export const isAllProgressKey = (key: readonly unknown[]): boolean =>
  key[0] === 'progress' && key[1] === 'all';

/** The book a chapters query key names (`qk.chapters`), or null for any other key. */
export function chaptersKeyParts(
  key: readonly unknown[],
): { cid: string; libraryId: number; path: string } | null {
  const [kind, cid, libraryId, path] = key;
  if (kind !== 'chapters' || typeof cid !== 'string' || typeof libraryId !== 'number') return null;
  return typeof path === 'string' ? { cid, libraryId, path } : null;
}

/** Whether a query key is a book search for `q` on any connection (`qk.search`). */
export const isSearchKey = (key: readonly unknown[], q: string): boolean =>
  key[0] === 'search' && key[2] === q;

// --- Query specs ---------------------------------------------------------------------
// One spec per read that is also made outside a hook (`queryClient.fetchQuery` in the
// keep-ahead controller and the play path, `useQueries` fan-outs), so every caller hits
// the same cache entry with the same freshness. A null client gives no query function.

type MaybeClient = ApiClient | null | undefined;

/** `/server`: the version and flags don't change within a session. Kept while nothing
 * observes it, so a capability-gated hook mounted later starts from the known flags
 * (refreshed in the background once stale) instead of waiting on another round trip. */
export function serverInfoQuery(cid: string, client: MaybeClient) {
  return queryOptions({
    queryKey: qk.server(cid),
    queryFn: client ? ({ signal }) => client.serverInfo(signal) : skipToken,
    staleTime: 5 * 60_000,
    gcTime: Infinity,
  });
}

/**
 * `queryClient.fetchQuery` for a reader outside React that waits on the answer (the play
 * path, the end of a book, keep-ahead): it always settles, so the caller's fallback for a
 * failed read gets to run. TanStack's default network mode holds a fetch while the browser
 * says it is offline, and any retry waits until a hidden tab is focused again, so a book
 * about to start, or the end-of-book chain in a background tab, waited with no error until
 * the browser came back. This read asks whatever the online flag says (`networkMode:
 * 'always'`), is never retried, and first drops a fetch that a mounted hook is holding for
 * the same key: it would otherwise be joined and waited on (the hook fetches again once
 * the browser is back online). Fresh cached data still comes back without asking.
 */
export async function fetchFailFast<
  TQueryFnData,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>): Promise<TData> {
  await queryClient.cancelQueries({
    queryKey: options.queryKey,
    exact: true,
    fetchStatus: 'paused',
  });
  return queryClient.fetchQuery({ ...options, networkMode: 'always', retry: false });
}

/** A connection's server flags through the shared `/server` entry (normally cached, so
 * no request): for the framework-free readers (the end-of-book flow, keep-ahead, the
 * transcode decision). Read with `fetchFailFast`; when the server can't be read, the
 * flags the cache last held (they don't change within a session). Rejects when the
 * server can't be read and nothing is cached. */
export async function fetchCapabilities(cid: string, client: ApiClient): Promise<Capabilities> {
  try {
    return (await fetchFailFast(serverInfoQuery(cid, client))).capabilities;
  } catch (err) {
    const known = queryClient.getQueryData<ServerInfo>(qk.server(cid))?.capabilities;
    if (known) return known;
    throw err;
  }
}

/** One flag of a connection's server as the cache holds it, without asking: `undefined`
 * while its `/server` has not been read (like `useCapability`). */
export function cachedCapability(cid: string, flag: keyof Capabilities): boolean | undefined {
  const caps = queryClient.getQueryData<ServerInfo>(qk.server(cid))?.capabilities;
  return caps ? !!caps[flag] : undefined;
}

/** How long a `/next` answer stays fresh where it is only a suggestion (Home's Next in
 * your series, keep-ahead's plan): the series doesn't move while you listen. */
const NEXT_BOOK_STALE_MS = 10 * 60_000;

/** `/next` for a book, as Home and keep-ahead read it (the player's `useNextBook` keeps
 * the default freshness). Ask only a server with `next_book`. */
export function nextBookQuery(cid: string, client: MaybeClient, libraryId: number, path: string) {
  return queryOptions({
    queryKey: qk.nextBook(cid, libraryId, path),
    queryFn: client ? ({ signal }) => client.nextBook(libraryId, path, signal) : skipToken,
    staleTime: NEXT_BOOK_STALE_MS,
  });
}

/** The server's home and away addresses (`GET /addresses`). Ask only a server with
 * `addresses` (pass no client otherwise). Read by the address runner on launch and on
 * reconnect (`src/api/address-runner.ts`) and by `useServerAddresses`. */
export function addressesQuery(cid: string, client: MaybeClient) {
  return queryOptions({
    queryKey: qk.addresses(cid),
    queryFn: client ? ({ signal }) => client.addresses(signal) : skipToken,
  });
}

/** A server's libraries. */
export function librariesQuery(cid: string, client: MaybeClient) {
  return queryOptions({
    queryKey: qk.libraries(cid),
    queryFn: client ? () => client.libraries() : skipToken,
  });
}

/** The caller's collections (their own and those shared with them). Ask only a server
 * with `collections`. */
export function collectionsQuery(cid: string, client: MaybeClient) {
  return queryOptions({
    queryKey: qk.collections(cid),
    queryFn: client ? ({ signal }) => client.collections(signal) : skipToken,
  });
}

/** One collection with its items. Ask only a server with `collections`. */
export function collectionQuery(cid: string, client: MaybeClient, id: number) {
  return queryOptions({
    queryKey: qk.collection(cid, id),
    queryFn: client ? ({ signal }) => client.collection(id, signal) : skipToken,
  });
}

/** The Up next queue. Ask only a server with `queue`. */
export function queueQuery(cid: string, client: MaybeClient) {
  return queryOptions({
    queryKey: qk.queue(cid),
    queryFn: client ? ({ signal }) => client.queue(signal) : skipToken,
  });
}

/** Every saved progress row of a connection. */
export function allProgressQuery(cid: string, client: MaybeClient) {
  return queryOptions({
    queryKey: qk.allProgress(cid),
    queryFn: client ? () => client.allProgress() : skipToken,
  });
}

/** A book search (the server's search covers title, author, narrator and series); an
 * empty query asks nothing. */
export function searchQuery(cid: string, client: MaybeClient, q: string) {
  return queryOptions({
    queryKey: qk.search(cid, q),
    queryFn: client && q.length > 0 ? ({ signal }) => client.search(q, 50, signal) : skipToken,
  });
}

/** A book's item (with its files). */
export function itemQuery(cid: string, client: MaybeClient, libraryId: number, path: string) {
  return queryOptions({
    queryKey: qk.item(cid, libraryId, path),
    queryFn:
      client && path.length > 0 ? ({ signal }) => client.item(libraryId, path, signal) : skipToken,
  });
}

/** How long a book's chapters stay fresh: they change only when a rescan re-reads the
 * book (a Bridge job that wrote the book's files has them read again at its finish:
 * `refreshAfterFinish`). The play and download paths ask for a fresher answer of their
 * own (30 s). */
const CHAPTERS_STALE_MS = 30 * 60_000;

/** A book's chapters and files. */
export function chaptersQuery(cid: string, client: MaybeClient, libraryId: number, path: string) {
  return queryOptions({
    queryKey: qk.chapters(cid, libraryId, path),
    queryFn:
      client && path.length > 0
        ? ({ signal }) => client.chapters(libraryId, path, signal)
        : skipToken,
    staleTime: CHAPTERS_STALE_MS,
  });
}

/** How long community metadata stays fresh (the server caches it too). */
export const META_STALE_MS = 60 * 60_000;

/** How long an unmatched answer that carries a work (characters, recaps or a description
 * generated on this server) stays fresh. The server answers the same way when the community lookup
 * FAILED for a book it would otherwise match (instead of a 502), and keeps that failure
 * for 2 minutes: trusted for an hour, it would hide the book's community work that long. */
export const META_GENERATED_ONLY_STALE_MS = 2 * 60_000;

/** `bookMetaQuery`'s `staleTime`: the long one, but the short one for a generated-only
 * answer (see `META_GENERATED_ONLY_STALE_MS`). */
function metaStaleTime(query: { state: { data: BookMeta | undefined } }): number {
  const meta = query.state.data;
  return meta && !meta.matched && meta.work ? META_GENERATED_ONLY_STALE_MS : META_STALE_MS;
}

/** A book's community metadata envelope (capability `metadata`; `opts`, capability
 * `meta_bundle`, pick the request variant, each its own entry). Long `staleTime` (short
 * for a generated-only answer, `metaStaleTime`), except a `hideSpoilers` envelope, which
 * is cut at the saved progress when it is fetched; no retry (a 502 from a down meta
 * service should render nothing, not spin). */
export function bookMetaQuery(
  cid: string,
  client: MaybeClient,
  libraryId: number,
  path: string,
  opts?: BookMetaOptions,
) {
  return queryOptions({
    queryKey: qk.bookMeta(cid, libraryId, path, opts),
    queryFn:
      client && path.length > 0
        ? ({ signal }) => client.bookMeta(libraryId, path, signal, opts)
        : skipToken,
    ...(opts?.hideSpoilers ? {} : { staleTime: metaStaleTime }),
    retry: false,
  });
}

/** One community-metadata work by its meta-site id. Same policy as `bookMetaQuery`. */
export function metaWorkQuery(cid: string, client: MaybeClient, workId: string) {
  return queryOptions({
    queryKey: qk.metaWork(cid, workId),
    queryFn:
      client && workId.length > 0 ? ({ signal }) => client.metaWork(workId, signal) : skipToken,
    staleTime: META_STALE_MS,
    retry: false,
  });
}

/** A book's bookmarks. */
export function bookmarksQuery(cid: string, client: MaybeClient, libraryId: number, path: string) {
  return queryOptions({
    queryKey: qk.bookmarks(cid, libraryId, path),
    queryFn: client && path.length > 0 ? () => client.bookmarks(libraryId, path) : skipToken,
  });
}

/** A book's notes. */
export function notesQuery(cid: string, client: MaybeClient, libraryId: number, path: string) {
  return queryOptions({
    queryKey: qk.notes(cid, libraryId, path),
    queryFn: client && path.length > 0 ? () => client.notes(libraryId, path) : skipToken,
  });
}

/** A book's listening history: all of it, or the newest `limit` sessions (its own entry
 * under the full one's key, so invalidating the book's history reaches both). */
export function historyQuery(
  cid: string,
  client: MaybeClient,
  libraryId: number,
  path: string,
  limit?: number,
) {
  const key = qk.history(cid, libraryId, path);
  return queryOptions({
    queryKey: limit === undefined ? key : [...key, limit],
    queryFn: client && path.length > 0 ? () => client.history(libraryId, path, limit) : skipToken,
  });
}

/** What a bookmark add sends: `label` only reaches a server with `annotations`. */
export type AddBookmarkVars = { position: number; note?: string; label?: BookmarkLabel };

/** The add request, with the one rule for its label (`addBookmark` and `useAddBookmark`
 * both send through it): `label` goes only to a server known to have `annotations` (not
 * known yet counts as no, since an older server rejects the unknown field); otherwise it
 * is dropped and the bookmark is still made. */
function postBookmark(
  client: ApiClient,
  annotations: boolean | undefined,
  libraryId: number,
  path: string,
  { position, note = '', label }: AddBookmarkVars,
): Promise<Bookmark> {
  return label !== undefined && annotations === true
    ? client.addBookmark(libraryId, path, position, note, label)
    : client.addBookmark(libraryId, path, position, note);
}

/** After an add: the book's bookmarks or notes (every reader: the book page, the
 * companion, the scrubber pins) and the connection's across-books list. */
function refreshAfterAdd(
  qc: QueryClient,
  kind: 'bookmarks' | 'notes',
  cid: string,
  libraryId: number,
  path: string,
) {
  void qc.invalidateQueries({
    queryKey: kind === 'bookmarks' ? qk.myBookmarks(cid) : qk.myNotes(cid),
  });
  return qc.invalidateQueries({
    queryKey:
      kind === 'bookmarks' ? qk.bookmarks(cid, libraryId, path) : qk.notes(cid, libraryId, path),
  });
}

/**
 * Add a bookmark to a book on ONE connection's server, then refresh its lists
 * (`refreshAfterAdd`). Framework-free, for the callers that run outside React or for a
 * book that is not the screen's (the playing book's shortcut, the sleep timer's "Fell
 * asleep", a delete's Undo). `label` follows `postBookmark`'s rule, on the cached
 * `/server` answer. Resolves the new bookmark; rejects when the connection is gone or the
 * server refused.
 */
export async function addBookmark(
  connectionId: string,
  libraryId: number,
  path: string,
  position: number,
  note = '',
  label?: BookmarkLabel,
): Promise<Bookmark> {
  const client = resolveClient(connectionId);
  if (!client) throw new Error('connection gone');
  const created = await postBookmark(
    client,
    cachedCapability(connectionId, 'annotations'),
    libraryId,
    path,
    { position, note, label },
  );
  void refreshAfterAdd(queryClient, 'bookmarks', connectionId, libraryId, path);
  return created;
}

/** `addBookmark` for a note: pin `body` at `position` of a book on ONE connection's
 * server (every server takes a place), then refresh its lists. Framework-free (a
 * delete's Undo). */
export async function addNote(
  connectionId: string,
  libraryId: number,
  path: string,
  body: string,
  position: number,
): Promise<Note> {
  const client = resolveClient(connectionId);
  if (!client) throw new Error('connection gone');
  const created = await client.addNote(libraryId, path, body, position);
  void refreshAfterAdd(queryClient, 'notes', connectionId, libraryId, path);
  return created;
}

/** The scoped connection's server identity/capabilities (incl. its release version).
 * Resolves via `useCid()` (route scope → active), so the per-connection account screen
 * gets *its* server's version; pass `connectionId` to address a specific connection
 * instead. Tolerates an unconfigured server (returns disabled). */
export function useServerInfo(connectionId?: string) {
  return useQuery(serverInfoQuery(useCid(connectionId), useOptionalApi(connectionId)));
}

/** Whether the connection's server advertises a capability: `undefined` while that is
 * not known (its `/server` info still loading, or unreachable), then `true` or `false`
 * (an older server that lacks the flag reads `false`). The gated hooks below only
 * ever ask a server whose flag is `true`; elsewhere their query never runs and stays
 * pending. So a screen chooses its fallback (or hides the feature) on `false`, and on
 * `undefined` waits or decides for itself. */
export function useCapability(
  flag: keyof Capabilities,
  connectionId?: string,
): boolean | undefined {
  const caps = useServerInfo(connectionId).data?.capabilities;
  return caps ? !!caps[flag] : undefined;
}

/** Every connection's advertised capabilities, `undefined` while its `/server` is not
 * known (loading or unreachable): one `/server` read per connection, shared with
 * `useServerInfo`. */
export function useCapabilitiesAll(): Record<string, Capabilities | undefined> {
  const apis = useApis();
  return useQueries({
    queries: apis.map(({ connection, client }) => serverInfoQuery(connection.id, client)),
    combine: (results) =>
      Object.fromEntries(results.map((r, i) => [apis[i].connection.id, r.data?.capabilities])),
  });
}

/** Whether any server has a capability: true as soon as one does, false once every one
 * is known to lack it, undefined while that is still open. */
export function anyCapability(
  caps: Record<string, Capabilities | undefined>,
  flag: keyof Capabilities,
): boolean | undefined {
  const values = Object.values(caps);
  if (values.some((c) => c?.[flag])) return true;
  return values.length > 0 && values.every((c) => c !== undefined) ? false : undefined;
}

/** Rejection of a capability-gated mutation on a server that does not advertise its
 * flag, or whose `/server` info is not known yet (`unknown`): the request is never sent,
 * so an older server can't answer it with a bare 404, and no reconnect is flagged (only
 * a 401 does that). Never treat it as a network failure: no request was sent, so it says
 * nothing about whether the server answers. */
export class CapabilityError extends Error {
  constructor(
    public capability: keyof Capabilities,
    public unknown = false,
  ) {
    super(
      unknown
        ? `Not known yet whether this server supports ${capability}`
        : `This server does not support ${capability}`,
    );
    this.name = 'CapabilityError';
  }
}

/** A query that only runs once the connection's server advertises `flag`: until then it
 * has no function at all (`skipToken`), so not even a manual `refetch` reaches the
 * server (React Query rejects it instead). `ready` is the caller's own condition of the
 * same strength (an `enabled` flag, a valid id); `enabled` is React Query's own, which
 * only stops automatic fetching (a manual `refetch` still runs). */
function useCapabilityQuery<T, S = T>(
  flag: keyof Capabilities,
  queryKey: (cid: string) => readonly unknown[],
  load: (api: ApiClient, signal: AbortSignal) => Promise<T>,
  connectionId?: string,
  opts: {
    ready?: boolean;
    enabled?: boolean;
    staleTime?: number;
    retry?: boolean;
    refetchInterval?: (query: Query<T, Error, T, readonly unknown[]>) => number | false;
    select?: (data: T) => S;
  } = {},
) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const supported = useCapability(flag, connectionId) === true;
  return useQuery<T, Error, S, readonly unknown[]>({
    queryKey: queryKey(cid),
    queryFn:
      supported && api && opts.ready !== false ? ({ signal }) => load(api, signal) : skipToken,
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    ...(opts.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
    ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    ...(opts.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
    ...(opts.select !== undefined ? { select: opts.select } : {}),
  });
}

/** A capability-gated mutation: `request` runs against the connection's client only
 * when its server advertises `flag`; otherwise the mutation rejects with a
 * `CapabilityError` and sends nothing. `store` then brings the cache up to date before
 * the mutation resolves, inside the mutation function, so with the `cid` of the client
 * the request went to (an onSuccess would read the latest render's).
 * - `scope` runs one connection's writes of a capability one at a time, so the server
 *   applies them, and the cache takes their answers, in the order they were made.
 * - `mutationKey` names the connection: a pending (or queued) mutation takes each
 *   re-render's options, so a hook switched to another connection would send a queued
 *   write there. A changed key detaches the pending mutations instead, and they keep
 *   their own client and cache.
 * - `settled` runs once the request was sent, whatever the answer (`error` undefined when
 *   it succeeded, after `store`): for the reads a refusal can leave stale too (a 404 for
 *   something already gone, a cap that moved). */
function useCapabilityMutation<V, T>(
  flag: keyof Capabilities,
  connectionId: string | undefined,
  request: (api: ApiClient, vars: V) => Promise<T>,
  store?: (cache: { qc: QueryClient; cid: string }, answer: T, vars: V) => unknown,
  settled?: (cache: { qc: QueryClient; cid: string }, vars: V, error: unknown) => void,
) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const supported = useCapability(flag, connectionId);
  const qc = useQueryClient();
  return useMutation({
    ...mutationScope(flag, cid),
    mutationFn: async (vars: V) => {
      if (!api) throw new Error('no connection');
      if (supported !== true) throw new CapabilityError(flag, supported === undefined);
      let answer: T;
      try {
        answer = await request(api, vars);
      } catch (e) {
        settled?.({ qc, cid }, vars, e);
        throw e;
      }
      await store?.({ qc, cid }, answer, vars);
      settled?.({ qc, cid }, vars, undefined);
      return answer;
    },
  });
}

/** A capability's writes on ONE connection: their key and their one-at-a-time scope
 * (see `useCapabilityMutation`). */
function mutationScope(flag: keyof Capabilities, cid: string) {
  return { mutationKey: [flag, cid], scope: { id: `${flag}:${cid}` } };
}

/** Put a write's answer into the cache entry at `queryKey`. `update` gets the entry's
 * data (undefined when it has none) and returns its new data, or undefined when it
 * can't place the answer, and then the entry is read again instead (a no-op for an
 * entry nothing ever read). A read of the entry already in flight may have been
 * answered before the write and would land over the answer as fresh data, so it is
 * cancelled first and the entry read again after the answer is in; so is an entry an
 * earlier invalidation left waiting for a read (setting data would mark it fresh). */
async function storeAnswer<T>(
  qc: QueryClient,
  queryKey: readonly unknown[],
  update: (cached: T | undefined) => T | undefined,
) {
  const state = qc.getQueryState(queryKey);
  const fetching = state?.fetchStatus === 'fetching';
  const reread = fetching || state?.isInvalidated === true;
  if (fetching) await qc.cancelQueries({ queryKey, exact: true });
  const next = update(qc.getQueryData<T>(queryKey));
  if (next !== undefined) qc.setQueryData<T>(queryKey, next);
  if (next === undefined || reread) void qc.invalidateQueries({ queryKey, exact: true });
}

/** A `bookMeta` key of the `spoilers=hide` variant (see `qk.bookMeta`). */
function hidesSpoilers(queryKey: readonly unknown[]): boolean {
  return (queryKey[4] as { hide?: boolean } | undefined)?.hide === true;
}

/** Refresh what else a change to a book's progress makes stale: the listening stats
 * and the goal when it can move a finish (they count finish dates), and the book's
 * `spoilers=hide` metadata when it can move the saved place the server cuts that at
 * (the position, or the finished flag). */
function invalidateProgressDependents(
  qc: QueryClient,
  cid: string,
  libraryId: number,
  path: string,
  changed: { finish: boolean; place: boolean },
) {
  if (changed.finish) {
    void qc.invalidateQueries({ queryKey: qk.myStatsAll(cid) });
    void qc.invalidateQueries({ queryKey: qk.listeningGoal(cid) });
  }
  if (changed.place) {
    void qc.invalidateQueries({
      queryKey: qk.bookMeta(cid, libraryId, path),
      predicate: (q) => hidesSpoilers(q.queryKey),
    });
  }
}

export function useLibraries() {
  const api = useApi();
  const cid = useCid();
  return useQuery({ queryKey: qk.libraries(cid), queryFn: () => api.libraries() });
}

/** Server page size for the folder browse view (the server caps a page at 500). */
const BROWSE_PAGE_SIZE = 500;

/** A folder's full listing, fetched page-by-page via the server's `next_offset`
 * cursor. The browse screen drives `fetchNextPage` until the folder is exhausted
 * so the A–Z jump rail and the filter box operate on the complete list (a 1000-
 * entry folder is two requests; cached by React Query). */
export function useBrowseInfinite(libraryId: number, path: string) {
  const api = useApi();
  const cid = useCid();
  return useInfiniteQuery({
    queryKey: qk.browse(cid, libraryId, path),
    queryFn: ({ pageParam, signal }) =>
      api.browse(libraryId, path, pageParam, BROWSE_PAGE_SIZE, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined,
  });
}

// `useBook`/`useChapters` take an optional `connectionId` so the player (a root modal
// outside any route scope) can address the playing book's own server; content screens
// omit it and resolve to their route scope (the `?connection=` query param).
export function useBook(
  libraryId: number,
  path: string,
  connectionId?: string,
  { staleTime, enabled }: { staleTime?: number; enabled?: boolean } = {},
) {
  // Optional (not throwing) client: the player modal renders these hooks OUTSIDE the
  // `(app)` ContentScope guard, so a stale/removed connection id (e.g. tapping an
  // orphaned downloaded book) must yield a disabled query, not a fatal render throw.
  return useQuery({
    ...itemQuery(useCid(connectionId), useOptionalApi(connectionId), libraryId, path),
    ...(staleTime !== undefined ? { staleTime } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  });
}

/** A book's chapters and files; `enabled` false holds this reader back (a surface that
 * needs them only for community metadata the book may not have). */
export function useChapters(
  libraryId: number,
  path: string,
  connectionId?: string,
  { enabled }: { enabled?: boolean } = {},
) {
  return useQuery({
    ...chaptersQuery(useCid(connectionId), useOptionalApi(connectionId), libraryId, path),
    ...(enabled !== undefined ? { enabled } : {}),
  });
}

/** Enriched community metadata for a book. `enabled` gates the query on the
 * server's `metadata` capability (older servers never advertise it, so we never
 * probe an endpoint they lack). Long `staleTime` (the server caches too) and no
 * retry (a 502 from a down meta service should render nothing, not spin). `opts`
 * (capability `meta_bundle`) are part of the cache key, so each variant is its own
 * entry; a `hideSpoilers` envelope is cut at the caller's saved progress when it is
 * fetched, so it keeps only the default `staleTime`. */
export function useBookMeta(
  libraryId: number,
  path: string,
  enabled: boolean,
  opts?: BookMetaOptions,
) {
  return useQuery({
    ...bookMetaQuery(useCid(), useOptionalApi(), libraryId, path, opts),
    enabled,
  });
}

/** One community-metadata work by its meta-site id, for the "catch up on the
 * previous books" blocks. `enabled` is the caller's "this row is open" flag, so a
 * closed accordion never fetches. Same policy as `useBookMeta`: long `staleTime`
 * and no retry - and an older server (which lacks the route entirely) 404s, which
 * the UI renders as a quiet "couldn't load", never an error banner. */
export function useMetaWork(workId: string, enabled: boolean) {
  return useQuery({ ...metaWorkQuery(useCid(), useOptionalApi(), workId), enabled });
}

// --- Browse lists & next book ----------------------------------------------
// Each is gated on its own capability flag (via `useCapability`), so an older server
// is never asked for an endpoint it lacks: until the flag is known to be on, the query
// has no function at all (`skipToken`), so not even a manual `refetch` reaches the
// server (React Query rejects it instead). Each takes the optional `connectionId` like
// `useBook`, for a screen outside any route scope.

/** The browse lists are whole-library aggregates the server computes per request,
 * so they are kept fresh for a while rather than refetched on every mount. */
const BROWSE_STALE_MS = 5 * 60_000;

/** One browse list (capability `browse_people`). */
function useBrowseList<T>(
  queryKey: (cid: string) => readonly unknown[],
  load: (api: ApiClient, signal: AbortSignal) => Promise<T>,
  connectionId?: string,
) {
  return useCapabilityQuery('browse_people', queryKey, load, connectionId, {
    staleTime: BROWSE_STALE_MS,
  });
}

/** A library's authors with book counts (capability `browse_people`). */
export function useAuthors(libraryId: number, connectionId?: string) {
  return useBrowseList(
    (cid) => qk.authors(cid, libraryId),
    (api, signal) => api.authors(libraryId, signal),
    connectionId,
  );
}

/** A library's narrators with book counts (capability `browse_people`). */
export function useNarrators(libraryId: number, connectionId?: string) {
  return useBrowseList(
    (cid) => qk.narrators(cid, libraryId),
    (api, signal) => api.narrators(libraryId, signal),
    connectionId,
  );
}

/** A library's series with book counts and positions (capability `browse_people`): a
 * book in several series counts in each where the server can say so
 * (`series_memberships`). */
export function useSeriesList(libraryId: number, connectionId?: string) {
  const memberships = useCapability('series_memberships', connectionId) === true;
  return useBrowseList(
    (cid) => qk.seriesList(cid, libraryId, memberships),
    (api, signal) => api.seriesList(libraryId, { memberships }, signal),
    connectionId,
  );
}

/** Page size of `useLibraryBooks` (the server takes 1-200). */
const BOOKS_PAGE_SIZE = 100;

export type LibraryBooksOptions = {
  /** Books per page (1-200); a size other than the default is its own cache entry. */
  pageSize?: number;
  /** False: read the cache, fetch nothing. */
  enabled?: boolean;
  staleTime?: number;
  /** A plain series list (`isPlainSeriesQuery`) on a server with `series_books` fetches
   * its first page through `seriesBooksPage`, in one request with every other series
   * asked for in the same moment: for a screen of series cards. Only how the first page
   * is fetched: the cache entry is the same, so a reader without it reuses the answer. */
  batch?: boolean;
};

/** A library's indexed books (GET /libraries/{id}/books), page by page on the
 * server's cursor, optionally narrowed by exact `author`/`series`/`narrator` values
 * and sorted. `author`/`series` work on every server; a `narrator` filter needs
 * `browse_people` (an older server ignores it and would answer with the whole
 * library), so with one the query only runs once the server advertises the flag. A
 * `series` filter waits for `/server` (unless it fails) to learn whether to ask with
 * `memberships` (`series_memberships`). With `batch`, a plain series list on a server
 * with `series_books` fetches its first page through `seriesBooksPage` (one request for
 * every series card on screen); later pages, and every other list, use `listBooks`.
 * Either way the cache entry is the same, so the series page reuses a card's answer. */
export function useLibraryBooks(
  libraryId: number,
  query: BookListQuery = {},
  connectionId?: string,
  { pageSize = BOOKS_PAGE_SIZE, enabled, staleTime, batch }: LibraryBooksOptions = {},
) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  // One /server read for every flag below (as `useCapability` reads them: undefined
  // while not known).
  const server = useServerInfo(connectionId);
  const caps = server.data?.capabilities;
  const narratorOk = !!caps?.browse_people;
  // A series' books are every book in it where the server can say so; a series list
  // waits for the flag (as a narrator one waits for browse_people), so it isn't first
  // answered with the main series' books and then again.
  const memberships = caps ? !!caps.series_memberships : undefined;
  // (A server whose /server fails is no wait: the list then fails or answers alone.)
  const seriesReady = !query.series || memberships !== undefined || server.isError;
  const effective = query.series && memberships ? { ...query, memberships: true } : query;
  // Its flag comes in the same /server answer `seriesReady` waits for, so a card never
  // asks alone first and then in a batch.
  const batchedSeries =
    batch && caps?.series_books && isPlainSeriesQuery(effective) ? effective.series : undefined;
  const key = qk.libraryBooks(cid, libraryId, effective);
  return useInfiniteQuery({
    queryKey: pageSize === BOOKS_PAGE_SIZE ? key : [...key, { pageSize }],
    queryFn:
      api && (!query.narrator || narratorOk) && seriesReady
        ? // The batched first page never reads `ctx.signal`: react-query cancels (and
          // throws away) a fetch whose signal was read once its last observer leaves,
          // but a card scrolled off still has its page coming in the shared request,
          // and that page should land in the cache rather than be asked for again.
          // (An infinite query remembers a read for its whole life, so once a later
          // page has gone out on /books with the signal, a card leaving mid-refetch
          // still drops the refetch and keeps the pages it had.)
          (ctx) =>
            batchedSeries && ctx.pageParam === undefined
              ? api.seriesBooksPage(libraryId, batchedSeries, { limit: pageSize })
              : api.listBooks(
                  libraryId,
                  { ...effective, limit: pageSize, cursor: ctx.pageParam },
                  ctx.signal,
                )
        : skipToken,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor || undefined,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(staleTime !== undefined ? { staleTime } : {}),
  });
}

/**
 * EVERY book of a library list (`useLibraryBooks`: the whole library, or an exact
 * `series`, `author` or `narrator`), fetching the remaining pages on its own, for a
 * screen that orders or filters them on the device. The pages so far are usable at once
 * (`complete` false while more are coming); the second page is asked for once the first
 * has painted (`afterPaint`). A failed page stops the run and keeps what
 * loaded; `retry` carries on from there (or starts over when the first page failed).
 */
export function useAllLibraryBooks(
  libraryId: number,
  query: BookListQuery = {},
  connectionId?: string,
  opts: LibraryBooksOptions = {},
) {
  const q = useLibraryBooks(libraryId, query, connectionId, opts);
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, data, refetch } = q;
  // Keyed on the page count too: a page can arrive within one render of the request
  // that asked for it, leaving the flags as they were and the effect asleep.
  const pages = data?.pages.length ?? 0;
  useEffect(() => {
    if (!hasNextPage || isFetching || isFetchNextPageError) return;
    // The first page paints before the rest are asked for (web: `afterPaint` waits for
    // the frame and an idle moment), so their rendering never holds its covers back.
    if (pages === 1) return afterPaint(() => void fetchNextPage());
    void fetchNextPage();
  }, [pages, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
  const books = useMemo<Book[]>(() => data?.pages.flatMap((p) => p.books) ?? [], [data]);
  return {
    books,
    /** Every page is in. */
    complete: !!data && !hasNextPage,
    /** Nothing loaded yet (the first page is on its way). */
    isLoading: q.isPending && q.fetchStatus !== 'idle',
    /** The query can't run (no client, or a narrator filter on a server without it) or
     * hasn't yet (a series filter waiting for `/server`). */
    isIdle: q.isPending && q.fetchStatus === 'idle',
    error: q.error,
    retry: () => void (data ? fetchNextPage() : refetch()),
    /** Read the whole list again (an empty library: the server may have scanned since). */
    refresh: () => void refetch(),
  };
}

/** What to play after a book, resolved by the server (capability `next_book`).
 * Takes the optional `connectionId` like `useBook`, so the player (outside any route
 * scope) can ask the playing book's own server, and an `enabled` flag so the caller
 * fetches only when it needs the answer. On a server without the flag
 * (`useCapability('next_book', connectionId) === false`) it never asks: keep the
 * client-side folder-sibling fallback there. Keeps the short default `staleTime`: the
 * answer moves as books are added to the library. */
export function useNextBook(
  libraryId: number,
  path: string,
  enabled = true,
  connectionId?: string,
) {
  return useCapabilityQuery(
    'next_book',
    (cid) => qk.nextBook(cid, libraryId, path),
    (api, signal) => api.nextBook(libraryId, path, signal),
    connectionId,
    { ready: path.length > 0, enabled },
  );
}

/** A book's saved listening position (or null when it has never been played).
 * The book screen uses it to place the listener in the chapter list - which gates
 * the spoiler-aware community characters/recaps - without loading the player, and
 * passes its own `enabled` so the request only happens where that gating exists.
 * Optional client (like `useBook`/`useChapters`) so a stale connection yields a
 * disabled query rather than a render throw.
 *
 * Offline (or against an unreachable server) it falls back to the durable local
 * mirror - the same record the resume path trusts - so a downloaded book still
 * knows where the listener is instead of reading as "never started". An HTTP
 * error is NOT swallowed: it propagates and the query fails (see
 * `fetchBookProgress` for why that matters to the reconnect banner). */
export function useBookProgress(
  libraryId: number,
  path: string,
  enabled: boolean,
  connectionId?: string,
) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.progress(cid, libraryId, path),
    queryFn: ({ signal }) => fetchBookProgress(api!, cid, libraryId, path, signal),
    enabled: enabled && !!api && path.length > 0,
  });
}

/**
 * The `useBookProgress` fetch, extracted so the fallback policy is unit-testable.
 *
 * Ask the server; on failure fall back to the durable local mirror **only when the
 * server never answered**. The distinction is load-bearing:
 *  - An `ApiError` means the server DID answer with an HTTP error. Rethrow it so the
 *    query fails. A 401 in particular has already flagged the connection for reconnect
 *    via the client's `onAuthError`; resolving it as a *success* on `qk.progress(...)`
 *    would make provider.tsx's `QueryCache.onSuccess` immediately `clearNeedsReconnect`
 *    and wipe the banner the same request just raised. A 403 (scope/share denial) is
 *    likewise a real answer, not an excuse to serve stale local state.
 *  - Anything else (offline, DNS, `TimeoutError`) means we never reached the server:
 *    have its server checked (`noteFailure`, frontend#131) and serve the mirror so a
 *    downloaded book still knows where the listener is. Never marked down straight
 *    away: the mirror's success would have the down server checked, found up,
 *    and every query of the connection read again, this one included, round and round
 *    for a read that is only slow or broken.
 *
 * A cancelled query stays cancelled (the abort rethrows untouched).
 */
export async function fetchBookProgress(
  api: ApiClient,
  connectionId: string,
  libraryId: number,
  path: string,
  signal: AbortSignal,
): Promise<Progress | null> {
  try {
    return await api.getProgress(libraryId, path, signal);
  } catch (e) {
    // A cancelled query must stay cancelled - only a real failure falls back.
    if (signal.aborted) throw e;
    // The server answered (any HTTP status) - propagate, never mask it with the mirror.
    if (e instanceof ApiError) throw e;
    noteFailure(connectionId, e);
    return await mirroredProgress(connectionId, libraryId, path);
  }
}

/** Where the ebook reader opens a book (capability `ebooks`, Bridge Phase 3b): the newest
 * of the server's place, this device's mirror and its queued save, or that save when the
 * server will keep it (`lookupReadingPlace`, which falls back to this device's places when
 * the server can't be reached, and fails when it has none, unless the book's EPUB is on
 * this device: then it opens at the start). Read once per opening: nothing
 * kept after the reader closes, no retry (the screen's Try again looks again). Asked
 * whatever the browser's online flag says: held while it says offline, the reader would
 * wait on a spinner instead of opening at a local place or saying it can't. */
export function readingPlaceQuery(
  cid: string,
  api: ApiClient | null,
  libraryId: number,
  path: string,
  hasLocalCopy?: () => Promise<boolean>,
) {
  return queryOptions({
    queryKey: qk.readingPlace(cid, libraryId, path),
    queryFn: ({ signal }) =>
      lookupReadingPlace(api, cid, libraryId, path, signal, { hasLocalCopy }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    networkMode: 'always',
  });
}

/** The reader's {@link readingPlaceQuery}, once `enabled` (the book is readable).
 * `hasLocalCopy` says whether the book's EPUB is on this device: offline, with no place
 * here, such a book opens at its start (`lookupReadingPlace`). */
export function useReadingPlace(
  libraryId: number,
  path: string,
  connectionId?: string,
  enabled = true,
  hasLocalCopy?: () => Promise<boolean>,
) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    ...readingPlaceQuery(cid, api, libraryId, path, hasLocalCopy),
    enabled: enabled && path.length > 0,
  });
}

/** Mark a book finished. Goes through the offline-aware last-write-wins save so
 * it reconciles with playback progress, then refreshes the home lists and what else a
 * finish moves (the listening stats, the goal, the book's spoilers=hide metadata). */
export function useMarkFinished(connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: {
      libraryId: number;
      path: string;
      position: number;
      duration: number;
      playback_speed?: number;
    }) => {
      await saveProgress(api, {
        connectionId: cid,
        libraryId: p.libraryId,
        path: p.path,
        position: p.position,
        duration: p.duration,
        finished: true,
        playback_speed: p.playback_speed && p.playback_speed > 0 ? p.playback_speed : 1,
        device_id: await getDeviceId(),
        updated_at: new Date().toISOString(),
      });
    },
    onSuccess: (_data, p) => {
      qc.invalidateQueries({ queryKey: qk.allProgress(cid) });
      qc.invalidateQueries({ queryKey: qk.progress(cid, p.libraryId, p.path) });
      invalidateProgressDependents(qc, cid, p.libraryId, p.path, { finish: true, place: true });
    },
  });
}

// --- Bookmarks -------------------------------------------------------------
// Each of these takes an optional `connectionId` (defaults to the active connection):
// the player can drive bookmarks/notes/history for a book that is playing through a
// connection the user has since switched away from, so it must address that book's own
// server, not whatever is active. The book screen omits it (it operates on the active
// connection). Same shape as useMarkFinished/useToggleFavourite.
export function useBookmarks(libraryId: number, path: string, connectionId?: string) {
  return useQuery(bookmarksQuery(useCid(connectionId), useApi(connectionId), libraryId, path));
}

/** Bookmark a book at `position`, with an optional `note` and `label`, then refresh the
 * book's bookmarks and the across-books list. Works on every server: `label` follows
 * `postBookmark`'s rule, on this connection's `useCapability`. Resolves the new
 * bookmark. */
export function useAddBookmark(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const annotations = useCapability('annotations', connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: AddBookmarkVars) => postBookmark(api, annotations, libraryId, path, vars),
    onSuccess: () => refreshAfterAdd(qc, 'bookmarks', cid, libraryId, path),
  });
}

/** Delete one of a book's bookmarks, then refresh the book's bookmarks; the row leaves
 * the across-books list at once (which is read again). */
export function useDeleteBookmark(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteBookmark(id),
    onSuccess: (_none, id) => {
      refreshPages<MyBookmark>(qc, qk.myBookmarks(cid), (data) => removeFromPages(data, id));
      return qc.invalidateQueries({ queryKey: qk.bookmarks(cid, libraryId, path) });
    },
  });
}

/** Edit one of the caller's bookmarks, its `note` and/or `label` (capability
 * `annotations`; vars `{ id, ...BookmarkPatch }`, see {@link BookmarkPatch}). The returned
 * row replaces the cached one in its book's bookmarks and in the across-books list (so
 * the edit shows without a flash), and the across-books list is read again. Rejects with
 * a `CapabilityError`, sending nothing, when the flag is off or not known yet. */
export function useUpdateBookmark(connectionId?: string) {
  return useCapabilityMutation(
    'annotations',
    connectionId,
    (api, { id, ...patch }: BookmarkPatch & { id: number }) => api.updateBookmark(id, patch),
    async ({ qc, cid }, bookmark) => {
      refreshPages<MyBookmark>(qc, qk.myBookmarks(cid), (data) => replaceInPages(data, bookmark));
      await storeAnswer<Bookmark[]>(
        qc,
        qk.bookmarks(cid, bookmark.library_id, bookmark.path),
        (list) => replaceRow(list, bookmark),
      );
    },
  );
}

// --- Notes -----------------------------------------------------------------
export function useNotes(libraryId: number, path: string, connectionId?: string) {
  return useQuery(notesQuery(useCid(connectionId), useApi(connectionId), libraryId, path));
}

/** Add a note to a book, then refresh the book's notes and the across-books list. */
export function useAddNote(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { body: string; position?: number }) =>
      api.addNote(libraryId, path, vars.body, vars.position ?? 0),
    onSuccess: () => refreshAfterAdd(qc, 'notes', cid, libraryId, path),
  });
}

/** Delete one of a book's notes, then refresh the book's notes; the row leaves the
 * across-books list at once (which is read again). */
export function useDeleteNote(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteNote(id),
    onSuccess: (_none, id) => {
      refreshPages<MyNote>(qc, qk.myNotes(cid), (data) => removeFromPages(data, id));
      return qc.invalidateQueries({ queryKey: qk.notes(cid, libraryId, path) });
    },
  });
}

/** Edit one of the caller's notes, its `body` and/or `position` (capability
 * `annotations`; vars `{ id, ...NotePatch }`, see {@link NotePatch}). The returned row
 * replaces the cached one in its book's notes (kept in the server's position order) and
 * in the across-books list, which is then read again. Rejects with a `CapabilityError`,
 * sending nothing, when the flag is off or not known yet. */
export function useUpdateNote(connectionId?: string) {
  return useCapabilityMutation(
    'annotations',
    connectionId,
    (api, { id, ...patch }: NotePatch & { id: number }) => api.updateNote(id, patch),
    async ({ qc, cid }, note) => {
      refreshPages<MyNote>(qc, qk.myNotes(cid), (data) => replaceInPages(data, note));
      await storeAnswer<Note[]>(qc, qk.notes(cid, note.library_id, note.path), (list) => {
        const next = replaceRow(list, note);
        return next && byPosition(next);
      });
    },
  );
}

// --- History ---------------------------------------------------------------
export function useHistory(libraryId: number, path: string, connectionId?: string) {
  return useQuery(historyQuery(useCid(connectionId), useApi(connectionId), libraryId, path));
}

// --- Across books (Phase 4) -----------------------------------------------------
// The caller's bookmarks, notes and listening over every book, newest first, as infinite
// query options on the server's `next_cursor` (the Journal reads every server's at once,
// `useJournalSources`; call `fetchNextPage` while `hasNextPage`).
// `flattenPages` turns `data` into one list. Bookmarks and notes are gated on
// `annotations` like the Phase 1b reads (no query function at all until the flag is
// known to be on); history works on every server, and an older one answers one page.

/** Rows per page of the across-books lists (the server's default; it takes 1-500). */
const PAGE_SIZE = 100;

/** Every row of an across-books infinite query's pages so far, in order (`[]` before
 * the first page). */
export function flattenPages<T>(data: InfiniteData<Page<T>> | undefined): T[] {
  return data ? data.pages.flatMap((p) => p.items) : [];
}

/** How long an across-books list stays fresh: this device's writes refresh it at once
 * (`addBookmark`, the delete and edit hooks, a recorded span), so a revisit reads the
 * cache instead of asking again. */
const PAGED_STALE_MS = 5 * 60_000;

/**
 * When the last reader of an across-books list goes, keep only its first page: a list
 * read 20 pages deep would otherwise refetch all 20, one after another, the next time it
 * is read again. The cache keeps its date (and its invalidation, if a write left it
 * waiting for a read), so a revisit refreshes it exactly when it would have.
 */
export function keepFirstPage(qc: QueryClient, queryKey: readonly unknown[]) {
  const query = qc.getQueryCache().find({ queryKey, exact: true });
  if (!query || query.getObserversCount() > 0) return;
  const { data, dataUpdatedAt, isInvalidated } = query.state as {
    data?: InfiniteData<unknown>;
    dataUpdatedAt: number;
    isInvalidated: boolean;
  };
  if (!data || data.pages.length <= 1) return;
  qc.setQueryData<InfiniteData<unknown>>(
    queryKey,
    { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
    { updatedAt: dataUpdatedAt },
  );
  if (isInvalidated) void qc.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
}

/** An across-books list as infinite query options. A null `load` gives no query function
 * (`skipToken`), so not even a manual `refetch` asks. */
function pagedList<T>(
  queryKey: readonly unknown[],
  load: ((page: PageQuery, signal: AbortSignal) => Promise<Page<T>>) | null,
) {
  return infiniteQueryOptions<
    Page<T>,
    Error,
    InfiniteData<Page<T>, string | undefined>,
    readonly unknown[],
    string | undefined
  >({
    queryKey,
    queryFn: load
      ? ({ pageParam, signal }) => load({ limit: PAGE_SIZE, cursor: pageParam }, signal)
      : skipToken,
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next_cursor || undefined,
    staleTime: PAGED_STALE_MS,
  });
}

/** The caller's bookmarks across books, newest made first, each with its `book` when
 * indexed. Gated on `annotations`: `supported` is whether the connection's server is
 * known to have it (no query function otherwise). Read with `keepFirstPage` on release. */
export function myBookmarksQuery(cid: string, client: MaybeClient, supported: boolean) {
  return pagedList<MyBookmark>(
    qk.myBookmarks(cid),
    supported && client ? (page, signal) => client.myBookmarks(page, signal) : null,
  );
}

/** The caller's notes across books, as `myBookmarksQuery`. */
export function myNotesQuery(cid: string, client: MaybeClient, supported: boolean) {
  return pagedList<MyNote>(
    qk.myNotes(cid),
    supported && client ? (page, signal) => client.myNotes(page, signal) : null,
  );
}

/** The caller's listening spans across books, newest ended first. Not gated: every
 * server has `/me/history`. One with `annotations` pages on and sends each row's `book`;
 * an older one answers its newest 100 as the only page, without `book`. Kept under
 * `qk.historyAll`, so a recorded span refreshes it. */
export function myHistoryQuery(cid: string, client: MaybeClient) {
  return pagedList<HistoryEntry>(
    qk.myHistory(cid),
    client ? (page, signal) => client.allHistory(page, signal) : null,
  );
}

/** `row` in place of the list's row with its id, or undefined when the list (or the
 * row) isn't cached, so `storeAnswer` reads the list again. */
function replaceRow<T extends { id: number }>(list: T[] | undefined, row: T): T[] | undefined {
  return list?.some((r) => r.id === row.id)
    ? list.map((r) => (r.id === row.id ? row : r))
    : undefined;
}

/** The pages with `row`'s fields over the row of its id (keeping the row's `book`), or
 * undefined when no page holds it. */
function replaceInPages<T extends { id: number }>(
  data: InfiniteData<Page<T>>,
  row: Partial<T> & { id: number },
): InfiniteData<Page<T>> | undefined {
  if (!data.pages.some((p) => p.items.some((r) => r.id === row.id))) return undefined;
  return {
    ...data,
    pages: data.pages.map((p) => ({
      ...p,
      items: p.items.map((r) => (r.id === row.id ? { ...r, ...row } : r)),
    })),
  };
}

/** The pages without the row of `id`. */
function removeFromPages<T extends { id: number }>(
  data: InfiniteData<Page<T>>,
  id: number,
): InfiniteData<Page<T>> {
  return {
    ...data,
    pages: data.pages.map((p) => ({ ...p, items: p.items.filter((r) => r.id !== id) })),
  };
}

/** After a write: patch an across-books list in place where it can (so the change shows
 * at once), then read it again (a read already out is cancelled and made again, so it
 * can't land over the patch). A no-op for a list nothing has read. */
function refreshPages<T>(
  qc: QueryClient,
  queryKey: readonly unknown[],
  patch: (data: InfiniteData<Page<T>>) => InfiniteData<Page<T>> | undefined,
) {
  qc.setQueryData<InfiniteData<Page<T>>>(queryKey, (data) => (data ? patch(data) : undefined));
  void qc.invalidateQueries({ queryKey });
}

// --- Favourites ------------------------------------------------------------
/** The caller's favourites across every accessible library (one cross-library
 * call). Feeds the per-row hearts, the Favourites shelf, and the home section. */
export function useFavourites() {
  const api = useApi();
  const cid = useCid();
  return useQuery({
    queryKey: qk.favourites(cid),
    queryFn: ({ signal }) => api.favourites(signal),
    enabled: !!cid,
  });
}

/** What `useToggleFavourite` takes. `pendingBook` marks a folder `/fs` flags
 * `pending_book` (a book the scan has not indexed yet). */
export type ToggleFavouriteVars = {
  libraryId: number;
  path: string;
  on: boolean;
  pendingBook?: boolean;
};

/** Toggle a path's favourite state. Optimistically updates the shared favourites
 * list so the heart and shelf react instantly, then reconciles via invalidation
 * (which fills in server-derived fields like is_book/title for a fresh add).
 *
 * The server derives a favourite's `is_book` from its index when it lists them, so
 * hearting a `pendingBook` folder also reads the book (`GET /item` indexes it on
 * demand, as the book screen does), alongside the add: the mutation settles (and the
 * list is read again) only once both are done, otherwise Favourites and Home would show
 * it as a folder until the background scan arrives. That read is best effort; the
 * favourite is saved either way.
 *
 * The toggles of one connection run one at a time (`scope`), so an unheart tapped while
 * a heart's read is still out reaches the server after the add, never before it; and
 * only the last of a run reads the list again, so an earlier one's answer can't flip
 * the heart back while a later toggle is still waiting. */
export function useToggleFavourite(connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  const mutationKey = ['toggleFavourite', cid];
  return useMutation({
    mutationKey,
    scope: { id: `toggleFavourite:${cid}` },
    mutationFn: async ({ libraryId, path, on, pendingBook }: ToggleFavouriteVars) => {
      if (!on) return api.removeFavourite(libraryId, path);
      if (!pendingBook) return api.addFavourite(libraryId, path);
      // Through the item query, so the book screen opened next reads it from the cache.
      // Asked once, whatever the online flag says: a held or retried read would hold
      // back the heart.
      const read = qc
        .fetchQuery({
          ...itemQuery(cid, api, libraryId, path),
          networkMode: 'always',
          retry: false,
        })
        .then(
          // The read indexed the book: the folder listing that flagged it pending is
          // read again, so its row shows the book, not "Not scanned yet".
          () =>
            void qc.invalidateQueries({
              queryKey: qk.browse(cid, libraryId, parentPath(path)),
              exact: true,
            }),
          () => undefined,
        );
      const [, added] = await Promise.all([read, api.addFavourite(libraryId, path)]);
      return added;
    },
    onMutate: async ({ libraryId, path, on, pendingBook }) => {
      await qc.cancelQueries({ queryKey: qk.favourites(cid) });
      const prev = qc.getQueryData<Favourite[]>(qk.favourites(cid));
      qc.setQueryData<Favourite[]>(qk.favourites(cid), (cur) => {
        const list = cur ?? [];
        if (!on) return list.filter((f) => !(f.library_id === libraryId && f.path === path));
        if (list.some((f) => f.library_id === libraryId && f.path === path)) return list;
        // Minimal optimistic stub; onSettled refetch fills in is_book/title/etc.
        const stub: Favourite = {
          library_id: libraryId,
          path,
          is_book: !!pendingBook,
          title: '',
          author: '',
          series: '',
          series_index: 0,
          duration: 0,
          created_at: new Date().toISOString(),
        };
        return [stub, ...list];
      });
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.favourites(cid), ctx.prev);
    },
    // This mutation still counts itself here; a later toggle queued behind it reads
    // the list when it settles.
    onSettled: () =>
      qc.isMutating({ mutationKey }) === 1
        ? qc.invalidateQueries({ queryKey: qk.favourites(cid) })
        : undefined,
  });
}

// --- API keys --------------------------------------------------------------
// User-minted, named keys for headless integrations, scoped (like every other
// hook here) to a connection: each key belongs to one server, so the list query
// and both mutations key/invalidate on that connection's `qk.apiKeys(cid)` only.
// `enabled` lets the caller gate the list on the server's `api_keys` capability
// (and the non-demo rule) so an older server is never queried.

/** The caller's API keys for this connection (metadata only), newest first. Resolves
 * the client *optionally*: the account screen can render before a connection is scoped
 * (bare `/account` with no `?connection=`, so `cid` is `''`), and the rest of that
 * screen tolerates a missing client via `useOptionalApi` - so these hooks must too,
 * rather than throwing at render like `useApi`. The query simply stays disabled until
 * a client exists. */
export function useApiKeys(enabled: boolean, connectionId?: string) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.apiKeys(cid),
    queryFn: () => api!.listApiKeys(),
    enabled: enabled && !!api && !!cid,
  });
}

/** Mint a named API key; the plaintext secret is in the resolved value (shown once).
 * Refreshes this connection's key list on success, and its device list (`/me/devices`
 * lists API keys too). */
export function useCreateApiKey(connectionId?: string) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    // The section that fires this only renders under a real connection, so `api` is
    // present in practice; reject defensively if it somehow isn't (the caller surfaces it).
    mutationFn: (label: string) =>
      api ? api.createApiKey(label) : Promise.reject(new Error('no connection')),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.myDevices(cid) });
      return qc.invalidateQueries({ queryKey: qk.apiKeys(cid) });
    },
  });
}

/** Revoke an API key by id; refreshes this connection's key and device lists on
 * success. */
export function useRevokeApiKey(connectionId?: string) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api ? api.revokeApiKey(id) : Promise.reject(new Error('no connection')),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.myDevices(cid) });
      return qc.invalidateQueries({ queryKey: qk.apiKeys(cid) });
    },
  });
}

// --- User state & personal stats (Phase 1b) ----------------------------------
// Each query is gated on its own capability flag like the browse lists above (no query
// function until the flag is known to be on, so not even a `refetch` asks an older
// server). Each mutation checks the same flag when it is called and, on a server without
// it (or before its `/server` info is known), rejects with a `CapabilityError` without
// sending a request. All take the optional `connectionId`, like `useBook`.

/** The caller's Up next queue, in order (capability `queue`). */
export function useQueue(connectionId?: string) {
  return useCapabilityQuery('queue', qk.queue, (api, signal) => api.queue(signal), connectionId);
}

/** Replace the whole queue (capability `queue`). The cache takes the stored queue the
 * server answers with (entries it skipped are gone from it). The replace deletes every
 * stored entry it doesn't list, hidden ones included (see `ApiClient.setQueue`): move
 * one book with {@link useAddToQueue} and a `position` instead. */
export function useSetQueue(connectionId?: string) {
  return useCapabilityMutation(
    'queue',
    connectionId,
    (api, items: BookRef[]) => api.setQueue(items),
    ({ qc, cid }, queue) => storeAnswer(qc, qk.queue(cid), () => queue),
  );
}

/** Queue one book, at `position` (0-based, in the queue as the caller sees it) or the
 * end (capability `queue`). */
export function useAddToQueue(connectionId?: string) {
  return useCapabilityMutation(
    'queue',
    connectionId,
    (api, v: { libraryId: number; path: string; position?: number }) =>
      api.addToQueue(v.libraryId, v.path, v.position),
    ({ qc, cid }, queue) => storeAnswer(qc, qk.queue(cid), () => queue),
  );
}

/** Take one book off the queue (capability `queue`): the entry's own path (a remove is
 * exact, unlike an add). */
export function useRemoveFromQueue(connectionId?: string) {
  return useCapabilityMutation(
    'queue',
    connectionId,
    (api, v: { libraryId: number; path: string }) => api.removeFromQueue(v.libraryId, v.path),
    // Not awaited: the queue's next write (same scope) needn't wait for this read.
    ({ qc, cid }) => void qc.invalidateQueries({ queryKey: qk.queue(cid) }),
  );
}

/** {@link useRemoveFromQueue} outside React (the end of a book, which may run with no
 * screen mounted): the same request, cache refresh and per-connection write order.
 * Rejects with a `CapabilityError`, sending nothing, unless the cached `/server` says the
 * server has `queue`. */
export function removeFromQueue(
  cid: string,
  client: ApiClient,
  v: { libraryId: number; path: string },
): Promise<void> {
  return new MutationObserver(queryClient, {
    ...mutationScope('queue', cid),
    mutationFn: async () => {
      const supported = cachedCapability(cid, 'queue');
      if (supported !== true) throw new CapabilityError('queue', supported === undefined);
      await client.removeFromQueue(v.libraryId, v.path);
      void queryClient.invalidateQueries({ queryKey: qk.queue(cid) });
    },
  }).mutate();
}

/** The caller's collections: owned first, then shared with them (capability
 * `collections`). */
export function useCollections(connectionId?: string) {
  return useCapabilityQuery(
    'collections',
    qk.collections,
    (api, signal) => api.collections(signal),
    connectionId,
  );
}

/** One collection with its items (capability `collections`). Waits for a real id. */
export function useCollection(id: number, connectionId?: string) {
  return useCapabilityQuery(
    'collections',
    (cid) => qk.collection(cid, id),
    (api, signal) => api.collection(id, signal),
    connectionId,
    { ready: id > 0 },
  );
}

/** The users the caller can share a collection with (capability `collections`). A demo
 * account is refused (403), so pass `enabled` false for one, and while the share sheet
 * is closed. */
export function useShareTargets(enabled = true, connectionId?: string) {
  return useCapabilityQuery(
    'collections',
    qk.shareTargets,
    (api, signal) => api.shareTargets(signal),
    connectionId,
    { ready: enabled },
  );
}

/** The server's order of the collections list: owned first, then each group newest
 * `updated_at` first (fixed-width UTC stamps, so they compare as strings), then newest
 * id. */
function collectionOrder(a: Collection, b: Collection) {
  if (a.owned !== b.owned) return a.owned ? -1 : 1;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return b.id - a.id;
}

/** Put a collection a write answered with into the cached list (its count, preview
 * and `updated_at` move with the items), in the server's order. A list that doesn't
 * hold it is read again instead. */
function patchCollectionsList(qc: QueryClient, cid: string, collection: Collection) {
  return storeAnswer<Collection[]>(qc, qk.collections(cid), (list) =>
    list?.some((c) => c.id === collection.id)
      ? list.map((c) => (c.id === collection.id ? collection : c)).sort(collectionOrder)
      : undefined,
  );
}

/** Cache a collection a write answered with (a rename, new shares): into its cached
 * detail, if any, and the list. */
function storeCollection(qc: QueryClient, cid: string, collection: Collection) {
  return Promise.all([
    storeAnswer<CollectionDetail>(
      qc,
      qk.collection(cid, collection.id),
      (d) => d && { ...d, collection },
    ),
    patchCollectionsList(qc, cid, collection),
  ]);
}

/** Cache a collection detail a write answered with, and its collection in the list. */
function storeCollectionDetail(qc: QueryClient, cid: string, detail: CollectionDetail) {
  return Promise.all([
    storeAnswer(qc, qk.collection(cid, detail.collection.id), () => detail),
    patchCollectionsList(qc, cid, detail.collection),
  ]);
}

/** Forget a deleted (or left) collection's cached detail. A screen still showing it
 * keeps its data until it leaves, since removing an entry something observes makes the
 * observer read it again at once (a 404 now); it is only marked stale, so the next
 * reader asks the server. */
function dropCollectionDetail(qc: QueryClient, cid: string, id: number) {
  const queryKey = qk.collection(cid, id);
  if (qc.getQueryCache().find({ queryKey, exact: true })?.getObserversCount()) {
    void qc.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
  } else {
    qc.removeQueries({ queryKey, exact: true });
  }
}

/** Create a collection (capability `collections`); resolves to it. */
export function useCreateCollection(connectionId?: string) {
  return useCapabilityMutation(
    'collections',
    connectionId,
    (api, input: CollectionInput) => api.createCollection(input),
    ({ qc, cid }) => void qc.invalidateQueries({ queryKey: qk.collections(cid) }),
  );
}

/** Rename a collection or change its description (owner only; capability
 * `collections`). */
export function useUpdateCollection(connectionId?: string) {
  return useCapabilityMutation(
    'collections',
    connectionId,
    (api, { id, ...patch }: CollectionPatch & { id: number }) => api.updateCollection(id, patch),
    ({ qc, cid }, collection) => storeCollection(qc, cid, collection),
  );
}

/** Delete a collection (owner) or leave one shared with the caller (viewer); capability
 * `collections`. A screen showing the collection keeps its data (see
 * `dropCollectionDetail`): leave it once the mutation resolves. */
export function useDeleteCollection(connectionId?: string) {
  return useCapabilityMutation(
    'collections',
    connectionId,
    (api, id: number) => api.deleteCollection(id),
    ({ qc, cid }, _none, id) => {
      dropCollectionDetail(qc, cid, id);
      // Gone from the list at once: a form that picks collections must never offer (or
      // keep) one deleted a moment ago while the list is read again.
      qc.setQueryData<Collection[]>(qk.collections(cid), (list) =>
        list?.filter((c) => c.id !== id),
      );
      void qc.invalidateQueries({ queryKey: qk.collections(cid) });
      // The household members list names the collections shared with each member.
      void qc.invalidateQueries({ queryKey: qk.householdMembers(cid) });
    },
  );
}

/** Replace a collection's items (owner only; capability `collections`). The cache takes
 * the stored detail the server answers with. Like {@link useSetQueue}, the replace
 * deletes the caller's hidden items too: move one book with
 * {@link useAddCollectionItem} and a `position` instead. */
export function useSetCollectionItems(connectionId?: string) {
  return useCapabilityMutation(
    'collections',
    connectionId,
    (api, v: { id: number; items: BookRef[] }) => api.setCollectionItems(v.id, v.items),
    ({ qc, cid }, detail) => storeCollectionDetail(qc, cid, detail),
  );
}

/** Add one book to a collection (owner only; capability `collections`). */
export function useAddCollectionItem(connectionId?: string) {
  return useCapabilityMutation(
    'collections',
    connectionId,
    (api, v: { id: number; libraryId: number; path: string; position?: number }) =>
      api.addCollectionItem(v.id, v.libraryId, v.path, v.position),
    ({ qc, cid }, detail) => storeCollectionDetail(qc, cid, detail),
  );
}

/** Take one book out of a collection (owner only; capability `collections`): the
 * item's own path (a remove is exact, unlike an add). */
export function useRemoveCollectionItem(connectionId?: string) {
  return useCapabilityMutation(
    'collections',
    connectionId,
    (api, v: { id: number; libraryId: number; path: string }) =>
      api.removeCollectionItem(v.id, v.libraryId, v.path),
    ({ qc, cid }, _none, v) => {
      void qc.invalidateQueries({ queryKey: qk.collection(cid, v.id) });
      void qc.invalidateQueries({ queryKey: qk.collections(cid) });
    },
  );
}

/** Replace who a collection is shared with (owner only; capability `collections`). */
export function useSetCollectionShares(connectionId?: string) {
  return useCapabilityMutation(
    'collections',
    connectionId,
    (api, v: { id: number; userIds: number[] }) => api.setCollectionShares(v.id, v.userIds),
    async ({ qc, cid }, collection) => {
      await storeCollection(qc, cid, collection);
      // The household members list names the collections shared with each member: a
      // member card's "What can they listen to?" saves that set back whole.
      void qc.invalidateQueries({ queryKey: qk.householdMembers(cid) });
    },
  );
}

/** The caller's rating of exactly this path, or null (capability `ratings`). A rating
 * made through a part/disc path is stored on its book's path, so key rating UI on the
 * book's path. */
export function useRating(libraryId: number, path: string, connectionId?: string) {
  return useCapabilityQuery(
    'ratings',
    (cid) => qk.rating(cid, libraryId, path),
    (api, signal) => api.rating(libraryId, path, signal),
    connectionId,
    { ready: path.length > 0 },
  );
}

/** Every rating the caller can still see, newest change first (capability `ratings`). */
export function useMyRatings(connectionId?: string, opts: { enabled?: boolean } = {}) {
  return useCapabilityQuery(
    'ratings',
    qk.myRatings,
    (api, signal) => api.myRatings(signal),
    connectionId,
    opts,
  );
}

/** Rate a book (capability `ratings`). The server stores it on the BOOK's path (a
 * part/disc path rates its book), so the cache takes it under the path it came back
 * with. */
export function useSetRating(connectionId?: string) {
  return useCapabilityMutation(
    'ratings',
    connectionId,
    (api, v: { libraryId: number; path: string; rating: RatingValue; note?: string }) =>
      api.setRating(v.libraryId, v.path, v.rating, v.note),
    ({ qc, cid }, rating) => {
      void qc.invalidateQueries({ queryKey: qk.myRatings(cid) });
      return storeAnswer(qc, qk.rating(cid, rating.library_id, rating.path), () => rating);
    },
  );
}

/** Remove the caller's rating of exactly this path (capability `ratings`): pass the
 * book's path a rating came back with (a part/disc path removes nothing). */
export function useDeleteRating(connectionId?: string) {
  return useCapabilityMutation(
    'ratings',
    connectionId,
    (api, v: { libraryId: number; path: string }) => api.deleteRating(v.libraryId, v.path),
    ({ qc, cid }, _none, v) => {
      void qc.invalidateQueries({ queryKey: qk.myRatings(cid) });
      return storeAnswer<Rating | null>(qc, qk.rating(cid, v.libraryId, v.path), () => null);
    },
  );
}

/** The caller's own progress edit (capability `progress_edit`; see {@link ProgressEdit}):
 * mark finished or unfinished, move the position, set or clear the dates. The cache
 * takes the stored progress under `qk.progress` and as its row of the all-progress
 * list. The stats and the goal's finished count are read again when the edit could
 * move a finish (it names `finished` or `finished_at`), and the book's spoilers=hide
 * metadata when it could move the saved progress it is cut at (`finished` or
 * `position`). To mark unfinished a book finished at its end, send a `position` too
 * (see {@link ProgressEdit}).
 *
 * Server-side only: it does NOT touch the player's local progress mirror or offline
 * queue (playback internals are frozen in this phase), so a device that has the book
 * loaded overrides the edit with its next save, as the server's last-write-wins rule
 * intends. */
export function useEditProgress(connectionId?: string) {
  return useCapabilityMutation(
    'progress_edit',
    connectionId,
    (api, v: { libraryId: number; path: string; edit: ProgressEdit }) =>
      api.editProgress(v.libraryId, v.path, v.edit),
    ({ qc, cid }, progress, { edit }) => {
      invalidateProgressDependents(qc, cid, progress.library_id, progress.path, {
        finish: edit.finished !== undefined || edit.finished_at !== undefined,
        place: edit.finished !== undefined || edit.position !== undefined,
      });
      const same = (p: Progress) =>
        p.library_id === progress.library_id && p.path === progress.path;
      return Promise.all([
        storeAnswer(qc, qk.progress(cid, progress.library_id, progress.path), () => progress),
        storeAnswer<Progress[]>(
          qc,
          qk.allProgress(cid),
          (list) =>
            list &&
            (list.some(same) ? list.map((p) => (same(p) ? progress : p)) : [progress, ...list]),
        ),
      ]);
    },
  );
}

/** What the stats hooks take besides the connection: `ready` (false: don't fetch, for a
 * caller that only needs it sometimes) and a `staleTime` (a past year never changes). */
type StatsQueryOpts = { ready?: boolean; staleTime?: number };

/** The caller's own listening stats for a period (capability `user_stats`). */
export function useMyStats(
  range: StatsRange = '30d',
  connectionId?: string,
  opts: StatsQueryOpts = {},
) {
  return useCapabilityQuery(
    'user_stats',
    (cid) => qk.myStats(cid, range),
    (api, signal) => api.myStats(range, signal),
    connectionId,
    opts,
  );
}

/** `/me/stats` for a period as query options, for a reader that fetches it itself (the
 * Year section's search for earlier years): the cache entry `useMyStats` reads. The caller
 * checks `user_stats` first. */
export function myStatsQuery(cid: string, client: MaybeClient, range: StatsRange) {
  return queryOptions({
    queryKey: qk.myStats(cid, range),
    queryFn: client ? ({ signal }) => client.myStats(range, signal) : skipToken,
  });
}

/** The caller's listening day by day for a period, for streaks and calendars
 * (capability `user_stats`). */
export function useMyListening(
  range: StatsRange = '30d',
  connectionId?: string,
  opts: StatsQueryOpts = {},
) {
  return useCapabilityQuery(
    'user_stats',
    (cid) => qk.myListening(cid, range),
    (api, signal) => api.myListening(range, signal),
    connectionId,
    opts,
  );
}

/** The caller's yearly goal and this year's finished books (capability `user_stats`). */
export function useListeningGoal(connectionId?: string, opts: StatsQueryOpts = {}) {
  return useCapabilityQuery(
    'user_stats',
    qk.listeningGoal,
    (api, signal) => api.listeningGoal(signal),
    connectionId,
    opts,
  );
}

/** Set the yearly goal, books finished per year 1-1000 (capability `user_stats`). */
export function useSetListeningGoal(connectionId?: string) {
  return useCapabilityMutation(
    'user_stats',
    connectionId,
    (api, booksPerYear: number) => api.setListeningGoal(booksPerYear),
    ({ qc, cid }, status) => storeAnswer(qc, qk.listeningGoal(cid), () => status),
  );
}

/** Clear the yearly goal (capability `user_stats`). */
export function useClearListeningGoal(connectionId?: string) {
  return useCapabilityMutation<void, void>(
    'user_stats',
    connectionId,
    (api) => api.clearListeningGoal(),
    ({ qc, cid }) =>
      storeAnswer<ListeningGoalStatus>(qc, qk.listeningGoal(cid), (s) => s && { ...s, goal: null }),
  );
}

/** The caller's own signed-in devices, most recently seen first (capability
 * `my_devices`). `enabled: false` asks nothing (its `data` may still be a cached answer:
 * ignore it then). */
export function useMyDevices(connectionId?: string, opts: { enabled?: boolean } = {}) {
  return useCapabilityQuery(
    'my_devices',
    qk.myDevices,
    (api, signal) => api.myDevices(signal),
    connectionId,
    { ready: opts.enabled !== false },
  );
}

/** Sign out one of the caller's devices (capability `my_devices`); resolves to
 * `{ current }`.
 *
 * Not for the device the caller is on (its row has `current: true`): revoking it kills
 * this connection's token before the app's sign-out teardown
 * (`teardownBeforeTokenRevoke`: stop playback, save the final position, flush the
 * queued progress) can run, so those saves are refused and lost. Sign out of the
 * connection the usual way for that row (`useSignOut`), which tears down first.
 *
 * Should it still be used on it, `current: true` means the token is dead: every later
 * request on this connection is refused, and the caller must sign out of the
 * connection locally. The hook refetches nothing in that case, since a refetch would
 * only 401 and raise the reconnect banner instead. Otherwise it refreshes the device
 * list and the API keys (a device can be an API key). */
export function useRevokeMyDevice(connectionId?: string) {
  const members = useCapability('household_members', connectionId) === true;
  return useCapabilityMutation(
    'my_devices',
    connectionId,
    // Only a server with `household_members` knows the parameter.
    (api, { id, alsoMembers }: RevokeMyDeviceVars) =>
      alsoMembers && members
        ? api.revokeMyDevice(id, { alsoMembers: true })
        : api.revokeMyDevice(id),
    ({ qc, cid }, res) => {
      if (res.current) return;
      void qc.invalidateQueries({ queryKey: qk.apiKeys(cid) });
      if (res.members_signed_out) invalidateHousehold(qc, cid);
      else void qc.invalidateQueries({ queryKey: qk.myDevices(cid) });
    },
  );
}

/** What `useRevokeMyDevice` takes: the device's id, and `alsoMembers` to also sign out the
 * caller's household members signed in on that device (its `member_sign_ins`).
 * `alsoMembers` is sent only to a server with `household_members`; elsewhere the device
 * alone is signed out. */
export type RevokeMyDeviceVars = { id: number; alsoMembers?: boolean };

/** Whether the caller shares what they are listening to with the house (capability
 * `household`; `{ share_listening }`, off by default). Fresh until the app restarts:
 * Home and every book page read it, and it only changes through `useSetHousehold`,
 * which stores the server's answer (a change made on another device shows on the next
 * launch). */
export function useHousehold(connectionId?: string) {
  return useCapabilityQuery(
    'household',
    qk.household,
    (api, signal) => api.household(signal),
    connectionId,
    { staleTime: Infinity },
  );
}

/** Share (`true`) or stop sharing what the caller is listening to (capability
 * `household`). Rejects with `CapabilityError` (sending nothing) while the server's
 * flag is off or not known yet (no request sent: not a network failure). A demo account is
 * refused by the server (403). Stores the answer and refreshes the house, which a
 * change of the caller's own choice opens or empties (it is reciprocal). */
export function useSetHousehold(connectionId?: string) {
  return useCapabilityMutation(
    'household',
    connectionId,
    (api, share: boolean) => api.setHousehold(share),
    ({ qc, cid }, settings) => {
      void qc.invalidateQueries({ queryKey: qk.houseListening(cid) });
      return storeAnswer(qc, qk.household(cid), () => settings);
    },
  );
}

/** How often the house is asked again while the app is in the foreground. */
export const HOUSE_POLL_MS = 60_000;

/** The house polls only while the app is in the foreground: a suspended or hidden app
 * asks nothing (the foreground refresh, `src/lib/app-resume.ts`, reads it again on
 * return, which restarts the interval). React Query's own focus check covers a hidden
 * web tab; AppState covers native, where nothing tells React Query about focus. */
export function housePollInterval(): number | false {
  return AppState.currentState === 'active' ? HOUSE_POLL_MS : false;
}

/** What the other people who share are listening to (capability `household`): `[]`
 * unless the caller shares. Polled every minute while the app is in the foreground
 * (`HOUSE_POLL_MS`). `enabled: false` holds it (no request at all), e.g. for a screen
 * that is not focused or a caller known not to share. */
export function useHouseListening(connectionId?: string, opts: { enabled?: boolean } = {}) {
  return useCapabilityQuery<HouseListening>(
    'household',
    qk.houseListening,
    (api, signal) => api.houseListening(signal),
    connectionId,
    { ready: opts.enabled !== false, refetchInterval: housePollInterval },
  );
}

// --- The Bridge (capability `bridge`, admin only; Bridge Phase 1a) -------------------
// The player's one Bridge kind is `sidecars.generate` (characters and recaps). The reads
// ask only a server with the flag, and only when the caller lets them (the screen's gate:
// an admin, the `sidecars` feature, `metadata`); a non-admin would get a 403. The writes
// reject with a `CapabilityError`, sending nothing, without the flag.

/** The finished jobs each cache has read a book's answers again for
 * (`refreshAfterFinish`), and the running jobs' checkpoints it has read the chapters again
 * at (`refreshMidRun`): once each, not on every read of the jobs. */
const finishesActedOn = new WeakMap<QueryClient, Set<string>>();

/** Whether this cache meets `mark` for the first time (and remembers it). */
function firstTime(qc: QueryClient, mark: string): boolean {
  let acted = finishesActedOn.get(qc);
  if (!acted) finishesActedOn.set(qc, (acted = new Set()));
  if (acted.has(mark)) return false;
  acted.add(mark);
  return true;
}

/** Whether a cached item or chapters answer is the book at `path` (its own path): under
 * that path, or under a part of it that the server answered with the book (the book page
 * keys both by the route's path, which can be a disc folder or a file of the book; the
 * item names the book by `rel_path`, the chapters answer by `path`). */
function isBookAnswerOf(query: Query, cid: string, libraryId: number, path: string): boolean {
  const [kind, c, lib, p] = query.queryKey;
  if ((kind !== 'item' && kind !== 'chapters') || c !== cid || lib !== libraryId) return false;
  const data = query.state.data as { rel_path?: string; path?: string } | undefined;
  return p === path || (kind === 'item' ? data?.rel_path : data?.path) === path;
}

/** After a book's jobs were read: the first time this cache sees its newest job that wrote
 * the book's files done (`latestDone`: a generate job, a description the console queued, or
 * its chapter detection), read the book's `/meta` (every variant, under the job's own
 * path), its item and its chapters (under any path that names them) again, and wait for
 * them, so the generated tabs and description are in, the item's `generated` flag is on and
 * the chapters a Bridge found in the narration (Phase 1d: their rows, their caption and the
 * spoiler gate's chapter starts) are listed before the job's status goes (no Generate offer
 * flashes back in between). Once per finish, and whatever the clocks say: nothing compares
 * the device's fetch times with the server's finish, which need not agree. */
async function refreshAfterFinish(qc: QueryClient, cid: string, jobs: readonly BridgeJob[]) {
  const job = latestDone(jobs);
  if (!job || job.library_id === null || job.path === null) return;
  if (!firstTime(qc, `${cid}:${job.id}`)) return;
  const { library_id: libraryId, path } = job;
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.bookMeta(cid, libraryId, path) }),
    qc.invalidateQueries({ predicate: (q) => isBookAnswerOf(q, cid, libraryId, path) }),
  ]);
}

/** While a generate run is past chapter detection (`midRunCheckpoint`): read the book's
 * chapters again once per step it reports, so the chapters it saves early (Bridge Phase 1d,
 * hours before its end) replace the player's parts with their caption mid-run. Only an
 * answer still without chapters of its own (at most one, no `chapters_source`): a book with
 * chapters gets nothing from the early save, and is never read again for it. Not waited
 * for: the job's status does not depend on it. */
function refreshMidRun(qc: QueryClient, cid: string, jobs: readonly BridgeJob[]) {
  const at = midRunCheckpoint(jobs);
  if (!at || at.job.library_id === null || at.job.path === null) return;
  if (!firstTime(qc, `${cid}:mid:${at.mark}`)) return;
  const { library_id: libraryId, path } = at.job;
  void qc.invalidateQueries({
    predicate: (q) => {
      if (q.queryKey[0] !== 'chapters' || !isBookAnswerOf(q, cid, libraryId, path)) return false;
      const data = q.state.data as ChaptersResponse | undefined;
      return !data || (data.chapters.length <= 1 && !data.chapters_source);
    },
  });
}

/**
 * A book's Bridge jobs, newest first (`path`: the book's own `rel_path`, which the jobs
 * carry), asked only while `enabled`. Polled (`bridgePollInterval`) only while a
 * `sidecars.generate` or `chapters.detect` job of it is open and `active` (the surface on
 * screen) with the app in the foreground; the answer that sees the job end stops it. A
 * finished job has the book's `/meta`, item and chapters read again before its answer lands
 * (`refreshAfterFinish`); a running generate job past chapter detection, its chapters
 * (`refreshMidRun`).
 * `select` narrows what the caller re-renders for (a poll that changes only the progress
 * leaves it alone).
 */
export function useBridgeJobs<S = BridgeJob[]>(
  libraryId: number,
  path: string,
  opts: { enabled: boolean; active: boolean; select?: (jobs: BridgeJob[]) => S },
  connectionId?: string,
) {
  const qc = useQueryClient();
  const cid = useCid(connectionId);
  return useCapabilityQuery<BridgeJob[], S>(
    'bridge',
    (c) => qk.bridgeJobs(c, libraryId, path),
    async (api, signal) => {
      const jobs = await api.bridgeJobs(libraryId, path, signal);
      refreshMidRun(qc, cid, jobs);
      await refreshAfterFinish(qc, cid, jobs);
      return jobs;
    },
    connectionId,
    {
      ready: opts.enabled && path.length > 0,
      retry: false,
      refetchInterval: (query) =>
        bridgePollInterval(query.state.data, opts.active && AppState.currentState === 'active'),
      select: opts.select,
    },
  );
}

/** What generating characters and recaps for a book would take (`GET
 * /admin/bridge/estimate`), read afresh each time it mounts (the confirmation opens), again
 * while a share holds Generate back (`estimatePollInterval`), and after a refused queue
 * (`useQueueBridgeJob`). */
export function useBridgeEstimate(libraryId: number, path: string, connectionId?: string) {
  return useCapabilityQuery<BridgeEstimate>(
    'bridge',
    (cid) => qk.bridgeEstimate(cid, libraryId, path),
    (api, signal) => api.bridgeEstimate(libraryId, path, SIDECARS_GENERATE, signal),
    connectionId,
    {
      ready: path.length > 0,
      staleTime: 0,
      retry: false,
      refetchInterval: (query) =>
        estimatePollInterval(query.state.data?.open_job, AppState.currentState === 'active'),
    },
  );
}

/** Put a job's answer into its book's job list (newest first): in place of the copy the
 * list holds, else (a new job) at its head. */
function storeJob(qc: QueryClient, cid: string, job: BridgeJob) {
  if (job.library_id === null || job.path === null) return;
  return storeAnswer<BridgeJob[]>(
    qc,
    qk.bridgeJobs(cid, job.library_id, job.path),
    (cached) => cached && (replaceRow(cached, job) ?? [job, ...cached]),
  );
}

/** Queue a Bridge job (`POST /admin/bridge/jobs`); the answer (a new job, or the open one
 * already queued for that kind and book) goes into the book's job list, which then polls.
 * A refusal (a job of another kind opened for the book meanwhile, say) reads the book's
 * estimate again, so an open confirmation holds Generate back with the reason. */
export function useQueueBridgeJob(connectionId?: string) {
  return useCapabilityMutation(
    'bridge',
    connectionId,
    (api, job: BridgeJobRequest) => api.queueBridgeJob(job),
    ({ qc, cid }, answer) => storeJob(qc, cid, answer),
    ({ qc, cid }, job, error) => {
      if (error) {
        void qc.invalidateQueries({ queryKey: qk.bridgeEstimate(cid, job.library_id, job.path) });
      }
    },
  );
}

/** Cancel a Bridge job; its answer replaces it in its book's job list. A refusal (it
 * already ended: a 409) reads the list again. */
export function useCancelBridgeJob(connectionId?: string) {
  return useCapabilityMutation(
    'bridge',
    connectionId,
    (api, job: Pick<BridgeJob, 'id' | 'library_id' | 'path'>) => api.cancelBridgeJob(job.id),
    ({ qc, cid }, answer) => storeJob(qc, cid, answer),
    ({ qc, cid }, job, error) => {
      if (error && job.library_id !== null && job.path !== null) {
        void qc.invalidateQueries({ queryKey: qk.bridgeJobs(cid, job.library_id, job.path) });
      }
    },
  );
}

// --- Podcasts (Bridge Phase 2d-1) ----------------------------------------------------
// Reading shows and episodes is core: never gated on `podcasts` (a podcast library is
// listed, or not, by `GET /libraries`), so ask only for a library of the podcasts kind.
// Follow and Unfollow are the Podcasts module's writes (`podcasts`, a `CapabilityError`
// while it is off or not known); the fetch status is `podcast_fetch`'s.

/** How long a show list and an episode page stay fresh: a feed is checked every few
 * hours at most, and following or a finished fetch refresh them. */
const PODCAST_STALE_MS = 5 * 60_000;

/** Whether a connection's cached library list holds `libraryId` as a podcast library,
 * without asking: for the framework-free readers (keep-ahead, the downloads rules). */
export function cachedPodcastLibrary(cid: string, libraryId: number): boolean {
  return !!queryClient
    .getQueryData<Library[]>(qk.libraries(cid))
    ?.some((l) => l.id === libraryId && isPodcastLibrary(l));
}

/** Whether `libraryId` is a podcast library on the connection, from its library list (a
 * list-shape book there is an episode: the lists carry no `episode`). */
export function useIsPodcastLibrary(libraryId: number, connectionId?: string): boolean {
  const cid = useCid(connectionId);
  const client = useOptionalApi(connectionId);
  const { data } = useQuery({
    ...librariesQuery(cid, client),
    select: (libs: Library[]) => libs.some((l) => l.id === libraryId && isPodcastLibrary(l)),
  });
  return data === true;
}

/** A podcast library's shows (`GET /libraries/{id}/podcasts`). */
export function podcastShowsQuery(cid: string, client: MaybeClient, libraryId: number) {
  return queryOptions({
    queryKey: qk.podcastShows(cid, libraryId),
    queryFn:
      client && libraryId > 0 ? ({ signal }) => client.podcastShows(libraryId, signal) : skipToken,
    staleTime: PODCAST_STALE_MS,
  });
}

/** A podcast library's shows; `enabled` false (a books library, nothing selected) asks
 * nothing. */
export function usePodcastShows(
  libraryId: number,
  connectionId?: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    ...podcastShowsQuery(useCid(connectionId), useOptionalApi(connectionId), libraryId),
    enabled,
  });
}

/** Page size of a show's episode list (the server takes 1-200). */
const EPISODES_PAGE_SIZE = 50;

/** A show's episodes in `order`, page by page on the server's cursor. The server orders
 * them (published, then path); the pages are never re-sorted here. */
export function usePodcastEpisodes(
  libraryId: number,
  show: string,
  order: PodcastEpisodeOrder,
  connectionId?: string,
) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  return useInfiniteQuery({
    queryKey: qk.podcastEpisodes(cid, libraryId, show, order),
    queryFn:
      api && libraryId > 0 && show
        ? ({ pageParam, signal }) =>
            api.podcastEpisodes(
              libraryId,
              { show, order, limit: EPISODES_PAGE_SIZE, cursor: pageParam },
              signal,
            )
        : skipToken,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p: PodcastEpisodePage) => p.next_cursor ?? undefined,
    staleTime: PODCAST_STALE_MS,
  });
}

/** A show's newest `limit` episodes (one page, newest first): Home's New episodes. */
export function latestEpisodesQuery(
  cid: string,
  client: MaybeClient,
  libraryId: number,
  show: string,
  limit: number,
) {
  return queryOptions({
    queryKey: qk.latestEpisodes(cid, libraryId, show, limit),
    queryFn:
      client && libraryId > 0
        ? ({ signal }) =>
            client.podcastEpisodes(libraryId, { show, order: 'newest', limit }, signal)
        : skipToken,
    staleTime: PODCAST_STALE_MS,
  });
}

/** The shows the caller follows and their follow requests (`GET /me/podcasts`). A
 * request this cache last saw open that has now ended `done` reads its library's show
 * list again (the show is there now; the followed shows came in this answer), whichever
 * observer asked. */
export function myPodcastsQuery(cid: string, client: MaybeClient) {
  return queryOptions({
    queryKey: qk.myPodcasts(cid),
    queryFn: client
      ? async ({ signal, client: qc }) => {
          const before = qc.getQueryData<MyPodcasts>(qk.myPodcasts(cid))?.requests;
          const answer = await client.myPodcasts(signal);
          const libs = new Set(requestsDone(before, answer.requests).map((r) => r.library_id));
          for (const lib of libs) {
            if (lib !== null) void qc.invalidateQueries({ queryKey: qk.podcastShows(cid, lib) });
          }
          return answer;
        }
      : skipToken,
    staleTime: PODCAST_STALE_MS,
  });
}

/** A library's follow requests (`GET /me/podcasts`'s `requests`; `libraryId` undefined:
 * every library's), open first then ended, each newest first. Read again every
 * `FOLLOW_REQUEST_POLL_MS` only while one of them is open, the surface showing them is
 * `active` (its screen focused) and the app in the foreground: nothing polls once they
 * have all ended. A request that ends `done` reads its library's show list again. Core:
 * no capability (the route lists nothing while the module never queued anything). */
export function useFollowRequests(
  libraryId: number | undefined,
  { active }: { active: boolean },
  connectionId?: string,
) {
  const cid = useCid(connectionId);
  const client = useOptionalApi(connectionId);
  const select = useCallback(
    (d: MyPodcasts) => libraryRequests(d.requests, libraryId),
    [libraryId],
  );
  return useQuery({
    ...myPodcastsQuery(cid, client),
    select,
    refetchInterval: (query) =>
      active &&
      AppState.currentState === 'active' &&
      query.state.data?.requests.some(
        (r) => (libraryId === undefined || r.library_id === libraryId) && isOpenRequest(r),
      )
        ? FOLLOW_REQUEST_POLL_MS
        : false,
  });
}

/** Mark a show followed or not in the cached show list, or drop it (a private show a
 * listener stops following leaves their lists), and read the followed shows again. */
function storeFollowing(
  qc: QueryClient,
  cid: string,
  libraryId: number,
  path: string,
  following: boolean,
  show?: PodcastShow,
) {
  qc.setQueryData<PodcastShow[]>(qk.podcastShows(cid, libraryId), (list) =>
    list
      ?.filter((s) => following || s.path !== path || !s.private)
      .map((s) => (s.path === path ? { ...s, ...show, following } : s)),
  );
  void qc.invalidateQueries({ queryKey: qk.myPodcasts(cid) });
}

/** Follow a show by its path (capability `podcasts`). The cached show list takes the
 * answer and the followed shows are read again. */
export function useFollowPodcast(connectionId?: string) {
  return useCapabilityMutation(
    'podcasts',
    connectionId,
    (api, v: { libraryId: number; path: string }) => api.followPodcast(v.libraryId, v.path),
    ({ qc, cid }, answer, v) =>
      storeFollowing(
        qc,
        cid,
        v.libraryId,
        v.path,
        true,
        answer.state === 'following' ? answer.show : undefined,
      ),
  );
}

/** What following by address answered, into the cache: a show the library had (`200
 * following`) into its show list (the list read again when it lacks the show) and the
 * followed shows read again; a new feed's request (`202 subscribing`) at the head of the
 * cached follow requests, so a screen showing them starts following it (`storeAnswer`: a
 * read already in flight, the follow requests' own poll, can't land over it). */
async function storeFollowByUrl(qc: QueryClient, cid: string, answer: PodcastFollowResult) {
  if (answer.state === 'following') {
    const { show } = answer;
    const list = qc.getQueryData<PodcastShow[]>(qk.podcastShows(cid, show.library_id));
    if (list?.some((s) => s.path === show.path)) {
      storeFollowing(qc, cid, show.library_id, show.path, true, show);
      return;
    }
    void qc.invalidateQueries({ queryKey: qk.podcastShows(cid, show.library_id) });
    void qc.invalidateQueries({ queryKey: qk.myPodcasts(cid) });
    return;
  }
  const { request } = answer;
  await storeAnswer<MyPodcasts>(
    qc,
    qk.myPodcasts(cid),
    (cached) =>
      cached && {
        ...cached,
        requests: [request, ...cached.requests.filter((r) => r.id !== request.id)],
      },
  );
}

/** Follow a feed by its address in a podcast library (capability `podcasts`): a
 * directory result, a pasted address. `private` only when the listener says the feed is
 * theirs alone. The cache takes the answer (`storeFollowByUrl`). */
export function useFollowPodcastByUrl(connectionId?: string) {
  return useCapabilityMutation(
    'podcasts',
    connectionId,
    (api, v: { libraryId: number; feedUrl: string; private?: boolean }) =>
      api.followPodcastByUrl(v.libraryId, v.feedUrl, { private: v.private }),
    ({ qc, cid }, answer) => storeFollowByUrl(qc, cid, answer),
  );
}

/** Ask a followed show to check its feed now (capability `podcasts`): 202. Nothing
 * follows the check (it is not a follow request): the caller reads the show again a while
 * later. */
export function useCheckPodcast(connectionId?: string) {
  return useCapabilityMutation(
    'podcasts',
    connectionId,
    (api, v: { libraryId: number; path: string }) => api.checkPodcast(v.libraryId, v.path),
  );
}

/** Export the followed public shows as OPML (capability `podcast_opml`; a core read the
 * module being off does not stop). Resolves with the document and its counts. */
export function useExportOpml(connectionId?: string) {
  return useCapabilityMutation('podcast_opml', connectionId, (api, _v: void) => api.exportOpml());
}

/** How long a directory search's results are held (the server's own cache is 15
 * minutes): an unchanged repeat asks nothing. */
const DISCOVERY_STALE_MS = 15 * 60_000;

/** The directories the server can search (capability `podcast_discovery`). */
export function usePodcastDiscoveryProviders(connectionId?: string) {
  return useCapabilityQuery(
    'podcast_discovery',
    qk.discoveryProviders,
    (api, signal) => api.podcastDiscoveryProviders(signal),
    connectionId,
    { staleTime: DISCOVERY_STALE_MS, retry: false },
  );
}

/** A submitted directory search: the cleaned text (`cleanSearchText`), the provider, the
 * country (iTunes only, else null) and the result count. */
export type PodcastSearchParams = {
  q: string;
  provider: PodcastDiscoveryProvider;
  country: string | null;
  limit: number;
};

/** One directory search (capability `podcast_discovery`), asked only once submitted
 * (`params` null asks nothing), never retried by itself (a refusal is the caller's to say:
 * its budget is small), and held for 15 minutes. */
export function usePodcastSearch(params: PodcastSearchParams | null, connectionId?: string) {
  return useCapabilityQuery(
    'podcast_discovery',
    (cid) =>
      qk.discoverySearch(
        cid,
        params?.provider ?? '',
        params?.q ?? '',
        params?.country ?? null,
        params?.limit ?? 0,
      ),
    // `ready` holds the query until there are params.
    (api, signal) => api.searchPodcastDirectory(params!, signal),
    connectionId,
    { ready: params !== null, staleTime: DISCOVERY_STALE_MS, retry: false },
  );
}

/** Stop following a show (capability `podcasts`): the cached show list drops the mark (a
 * private show, the show itself) and the followed shows are read again. */
export function useUnfollowPodcast(connectionId?: string) {
  return useCapabilityMutation(
    'podcasts',
    connectionId,
    (api, v: { libraryId: number; path: string }) => api.unfollowPodcast(v.libraryId, v.path),
    ({ qc, cid }, _answer, v) => storeFollowing(qc, cid, v.libraryId, v.path, false),
  );
}

/** An episode's fetch status, read once (capability `podcast_fetch`; never polled here:
 * the episode-fetch controller, `src/playback/episode-fetch.ts`, is the one poller and
 * keeps this entry up to date while it watches). `enabled` false asks nothing. */
export function usePodcastFetchStatus(
  libraryId: number,
  path: string,
  connectionId?: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useCapabilityQuery<PodcastFetchStatus>(
    'podcast_fetch',
    (cid) => qk.podcastFetch(cid, libraryId, path),
    async (api, signal) => (await api.podcastFetchStatus(libraryId, path, signal)).fetch,
    connectionId,
    { ready: path.length > 0 && enabled, retry: false },
  );
}

// --- Household members (capability `household_members`, Phase 8b-1) -----------------
// The queries ask only a server that advertises the flag (`skipToken` elsewhere); the
// writes reject with a `CapabilityError`, sending nothing, while it is off or not known
// yet (no request sent: not a network failure). An owner can rename, sign out and delete their
// members whatever `allowed` says; only adding is gated by it.

/** The caller's household members, whether they may add more (`allowed`, else a
 * `reason`) and the most they may have (`max`). */
export function useHouseholdMembers(connectionId?: string) {
  return useCapabilityQuery(
    'household_members',
    qk.householdMembers,
    (api, signal) => api.members(signal),
    connectionId,
  );
}

/** One member's signed-in devices. `enabled: false` asks nothing (a member signed in
 * nowhere: their card says so from the list's count). */
export function useMemberDevices(
  id: number,
  connectionId?: string,
  opts: { enabled?: boolean } = {},
) {
  return useCapabilityQuery(
    'household_members',
    (cid) => qk.memberDevices(cid, id),
    (api, signal) => api.memberDevices(id, signal),
    connectionId,
    { ready: opts.enabled !== false },
  );
}

/**
 * Read again what shows a connection's household members signed in somewhere: the
 * members list (its device counts), the caller's devices (their `member_sign_ins`), and
 * one member's devices (`memberId`), else every member's.
 */
export function invalidateHousehold(qc: QueryClient, cid: string, memberId?: number) {
  void qc.invalidateQueries({ queryKey: qk.householdMembers(cid) });
  void qc.invalidateQueries({
    queryKey: memberId === undefined ? qk.memberDevicesAll(cid) : qk.memberDevices(cid, memberId),
  });
  void qc.invalidateQueries({ queryKey: qk.myDevices(cid) });
}

// Whoever is removed from this device (signed out, their person removed, a member's
// profile removed from the Household page: any path through `removeConnection`), every
// other connection here on the same server reads again what showed them signed in here
// (`invalidateHousehold`: the members' devices and counts, the owner's `member_sign_ins`).
// The removed connection's own answers are dropped by the provider.
onConnectionRemoved((id) => {
  const server = parseConnectionId(id).serverId;
  for (const c of useSession.getState().connections) {
    if (serverIdOf(c) === server) invalidateHousehold(queryClient, c.id);
  }
});

/** Read again the collections a member write changed the sharing of: the list and every
 * detail (each lists the people it is shared with, `shared_with`, which the share sheet
 * saves back as the full set: a stale one would unshare the member). */
function invalidateSharing(qc: QueryClient, cid: string) {
  void qc.invalidateQueries({ queryKey: qk.collections(cid) });
  void qc.invalidateQueries({ queryKey: qk.collectionAll(cid) });
}

/** A member write the server refused: read the members list again (a 404 means the member
 * is gone, elsewhere; the list on screen is the stale one). */
function rereadMembersOnRefusal(
  { qc, cid }: { qc: QueryClient; cid: string },
  _vars: unknown,
  error: unknown,
) {
  if (error !== undefined) void qc.invalidateQueries({ queryKey: qk.householdMembers(cid) });
}

/** Add a household member ({@link AddMemberBody}); resolves to `{ member, session? }`
 * (`session` when the body asked for `sign_in_here`: the member's session on this
 * device, to place as a connection). Reads the members list again whatever the answer (a
 * refusal can mean the cap or the admin's switch moved under the page); on success also
 * the caller's devices when a session was made here (their `member_sign_ins`) and the
 * collections when some were shared (each lists the people it is shared with). */
export function useAddMember(connectionId?: string) {
  return useCapabilityMutation(
    'household_members',
    connectionId,
    (api, body: AddMemberBody) => api.addMember(body),
    ({ qc, cid }, res, body) => {
      if (res.session) void qc.invalidateQueries({ queryKey: qk.myDevices(cid) });
      if (body.collection_ids) invalidateSharing(qc, cid);
    },
    ({ qc, cid }) => void qc.invalidateQueries({ queryKey: qk.householdMembers(cid) }),
  );
}

/** Sign one of the caller's members in on this device (takes the member's id); resolves
 * to their session. Refreshes the members list, that member's devices and the caller's
 * devices (their `member_sign_ins`); refused, reads the list again. */
export function useMemberSession(connectionId?: string) {
  return useCapabilityMutation(
    'household_members',
    connectionId,
    (api, id: number) => api.memberSession(id),
    ({ qc, cid }, _session, id) => invalidateHousehold(qc, cid, id),
    rereadMembersOnRefusal,
  );
}

/** A single-use pairing (QR) for one of the caller's members to sign in on their own
 * device (takes the member's id). Changes nothing cached: the device appears once it
 * signs in. Refused, reads the members list again. */
export function useMemberPairing(connectionId?: string) {
  return useCapabilityMutation(
    'household_members',
    connectionId,
    (api, id: number) => api.memberPairing(id),
    undefined,
    rereadMembersOnRefusal,
  );
}

/** Sign a member out of one of their devices (`{ id, deviceId }`, `id` the member's).
 * Refreshes that member's devices, the members list (its device count) and the caller's
 * devices (their `member_sign_ins`) whatever the answer: a 404 means the device was
 * signed out already (elsewhere), so the list on screen is the stale one. */
export function useRevokeMemberDevice(connectionId?: string) {
  return useCapabilityMutation(
    'household_members',
    connectionId,
    (api, { id, deviceId }: { id: number; deviceId: number }) =>
      api.revokeMemberDevice(id, deviceId),
    undefined,
    ({ qc, cid }, { id }) => invalidateHousehold(qc, cid, id),
  );
}

/** Change a member (`{ id, body }`, {@link UpdateMemberBody}); resolves to the member,
 * which takes its place in the members list. Making them a kid also reads their devices
 * and the list again (their API keys go); a change of what is shared with them reads the
 * collections again (each lists the people it is shared with). Refused, reads the list
 * again. */
export function useUpdateMember(connectionId?: string) {
  return useCapabilityMutation(
    'household_members',
    connectionId,
    (api, { id, body }: { id: number; body: UpdateMemberBody }) => api.updateMember(id, body),
    async ({ qc, cid }, member: HouseholdMember, { body }) => {
      await storeAnswer<HouseholdMembers>(qc, qk.householdMembers(cid), (list) =>
        list?.members.some((m) => m.id === member.id)
          ? { ...list, members: list.members.map((m) => (m.id === member.id ? member : m)) }
          : undefined,
      );
      if (body.kind === 'kid') {
        void qc.invalidateQueries({ queryKey: qk.householdMembers(cid) });
        void qc.invalidateQueries({ queryKey: qk.memberDevices(cid, member.id) });
      }
      if (body.collection_ids) invalidateSharing(qc, cid);
    },
    rereadMembersOnRefusal,
  );
}

/** Delete a member's account (takes the member's id). Takes them off the members list
 * at once, forgets their devices and refreshes the caller's devices (their
 * `member_sign_ins`) and the collections (the shares with them went with the account);
 * refused (a 404: deleted already, elsewhere), reads the list again. */
export function useDeleteMember(connectionId?: string) {
  return useCapabilityMutation(
    'household_members',
    connectionId,
    (api, id: number) => api.deleteMember(id),
    async ({ qc, cid }, _answer, id) => {
      qc.removeQueries({ queryKey: qk.memberDevices(cid, id), exact: true });
      await storeAnswer<HouseholdMembers>(
        qc,
        qk.householdMembers(cid),
        (list) => list && { ...list, members: list.members.filter((m) => m.id !== id) },
      );
      void qc.invalidateQueries({ queryKey: qk.myDevices(cid) });
      invalidateSharing(qc, cid);
    },
    rereadMembersOnRefusal,
  );
}

/** The server's home and away addresses as it answers them now (capability
 * `addresses`), for a screen that shows them (Account). Which address the player uses
 * right now is `useActiveAddress` (`src/api/address-route.ts`); the addresses the
 * device keeps are the connection's `addresses`. */
export function useServerAddresses(connectionId?: string) {
  const api = useOptionalApi(connectionId);
  const supported = useCapability('addresses', connectionId) === true;
  return useQuery(addressesQuery(useCid(connectionId), supported ? api : null));
}

// --- Cross-connection aggregation ------------------------------------------
// These fan out across every connection and merge, for the unified Home, Search
// and Libraries surfaces. Items are tagged with the connection they came from;
// books are de-duplicated (best-quality copy wins, source order breaks ties).
// Source priority = the order connections appear in the session list.

/** A library tagged with the connection it belongs to. */
export type SourcedLibrary = Library & { connectionId: string; connectionName: string };
/** A favourite/progress entry tagged with its connection. */
export type SourcedFavourite = Favourite & { connectionId: string; connectionName: string };
export type SourcedProgress = Progress & { connectionId: string; connectionName: string };

/** One connection's libraries, and whether its list has loaded. */
export type LibrariesOfServer = {
  connectionId: string;
  connectionName: string;
  libraries: SourcedLibrary[];
  status: 'loading' | 'ready' | 'error';
  /** Still `loading`, but waiting for the network: the device went offline before this
   * server's list answered (React Query pauses it), so it will not arrive meanwhile. */
  paused: boolean;
};

/** Every connection's libraries: flattened (`libraries`) and per server, in connection
 * order (`groups`). */
export function useLibrariesAll() {
  const apis = useApis();
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.libraries(connection.id),
      queryFn: () => client.libraries(),
    })),
    combine: (results) => {
      const groups = results.map((r, i): LibrariesOfServer => {
        const { id, name } = apis[i].connection;
        return {
          connectionId: id,
          connectionName: name,
          libraries: (r.data ?? []).map((l): SourcedLibrary => ({
            ...l,
            connectionId: id,
            connectionName: name,
          })),
          status: r.data ? 'ready' : r.isError ? 'error' : 'loading',
          paused: !r.data && r.fetchStatus === 'paused',
        };
      });
      return {
        groups,
        libraries: groups.flatMap((g) => g.libraries),
        isLoading: results.some((r) => r.isLoading),
        error: results.find((r) => r.error)?.error ?? null,
        /** Ask again every server whose list failed. */
        retry: () => {
          for (const r of results) if (r.isError) void r.refetch();
        },
        /** Ask one server again for its list (its own Retry). */
        retryServer: (connectionId: string) => {
          const r = results[apis.findIndex((a) => a.connection.id === connectionId)];
          if (r?.isError) void r.refetch();
        },
      };
    },
  });
}

export function useSearchAll(query: string) {
  const apis = useApis();
  const q = query.trim();
  const rank = (id: string) => {
    const i = apis.findIndex((a) => a.connection.id === id);
    return i === -1 ? apis.length : i;
  };
  return useQueries({
    queries: apis.map(({ connection, client }) => searchQuery(connection.id, client, q)),
    combine: (results) => ({
      books: dedupBooks(tagBooks(results, apis), rank),
      isFetching: results.some((r) => r.isFetching),
      error: results.find((r) => r.error)?.error ?? null,
    }),
  });
}

export function useRecentAll(limit = 48) {
  const apis = useApis();
  const rank = (id: string) => {
    const i = apis.findIndex((a) => a.connection.id === id);
    return i === -1 ? apis.length : i;
  };
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.recent(connection.id, limit),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.recentBooks(limit, signal),
    })),
    combine: (results) => ({
      books: dedupBooks(tagBooks(results, apis), rank),
      isLoading: results.some((r) => r.isLoading),
      error: results.find((r) => r.error)?.error ?? null,
    }),
  });
}

export function useFavouritesAll() {
  const apis = useApis();
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.favourites(connection.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.favourites(signal),
    })),
    combine: (results) => ({
      favourites: results.flatMap((r, i) =>
        (r.data ?? []).map((f): SourcedFavourite => ({
          ...f,
          connectionId: apis[i].connection.id,
          connectionName: apis[i].connection.name,
        })),
      ),
      isLoading: results.some((r) => r.isLoading),
      error: results.find((r) => r.error)?.error ?? null,
    }),
  });
}

export function useAllProgressAll({
  enabled = true,
  refetchOnMount = true,
}: {
  /** False: read whatever is cached, fetch nothing. */
  enabled?: boolean;
  /** False: a mount uses the cache as is (fetching only what was never loaded). */
  refetchOnMount?: boolean;
} = {}) {
  const apis = useApis();
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      ...allProgressQuery(connection.id, client),
      enabled,
      refetchOnMount,
    })),
    combine: (results) => ({
      // Newest first across all connections (no cross-connection merge yet).
      progress: results
        .flatMap((r, i) =>
          (r.data ?? []).map((p): SourcedProgress => ({
            ...p,
            connectionId: apis[i].connection.id,
            connectionName: apis[i].connection.name,
          })),
        )
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
      isLoading: results.some((r) => r.isLoading),
      error: results.find((r) => r.error)?.error ?? null,
    }),
  });
}

/** Where a book's saved progress is found: by (connection, library, path). */
export type SavedProgressOf = (
  connectionId: string,
  libraryId: number,
  path: string,
) => Progress | undefined;

/** A connection's progress rows by `library\npath`, built once per fetched list. */
const progressIndexes = new WeakMap<readonly Progress[], Map<string, Progress>>();
function progressIndex(rows: readonly Progress[]): Map<string, Progress> {
  let index = progressIndexes.get(rows);
  if (!index) {
    index = new Map(rows.map((p) => [`${p.library_id}\n${p.path}`, p]));
    progressIndexes.set(rows, index);
  }
  return index;
}

/**
 * The listener's saved progress on every connection, as a lookup by (connection,
 * library, path): what marks a spine finished, the book you're on and a tile's progress
 * bar. One fetch per connection, shared with Home and the palette; the lookup keeps its
 * identity until a list changes, and each list is indexed once.
 */
export function useProgressLookup(): {
  progressOf: SavedProgressOf;
  isLoading: boolean;
  /** Whether ONE connection's list is still loading (a screen about one server must not
   * wait on another that is slow or unreachable). */
  loadingOf: (connectionId: string) => boolean;
} {
  const apis = useApis();
  const ids = apis.map((a) => a.connection.id).join('\n');
  const combine = useCallback(
    (results: { data?: Progress[]; isLoading: boolean }[]) => {
      const cids = ids.split('\n');
      const byCid = new Map(cids.map((cid, i) => [cid, results[i]?.data]));
      const progressOf: SavedProgressOf = (cid, lib, path) => {
        const rows = byCid.get(cid);
        return rows ? progressIndex(rows).get(`${lib}\n${path}`) : undefined;
      };
      const loading = new Set(cids.filter((_, i) => results[i]?.isLoading));
      return {
        progressOf,
        isLoading: loading.size > 0,
        loadingOf: (cid: string) => loading.has(cid),
      };
    },
    [ids],
  );
  return useQueries({
    queries: apis.map(({ connection, client }) => allProgressQuery(connection.id, client)),
    combine,
  });
}

/**
 * One book's saved progress from its connection's cached progress list, for a tile
 * that marks itself (a progress bar, a finished flag). It reads the list other screens
 * already fetched: a mount never refetches it (a grid mounts tiles as it scrolls), and
 * only a connection whose list was never read fetches it once. The tile re-renders only
 * when its own row changes.
 */
export function useSavedProgress(
  libraryId: number,
  path: string,
  connectionId?: string,
  enabled = true,
): Progress | undefined {
  const cid = useCid(connectionId);
  const client = useOptionalApi(connectionId);
  return useQuery({
    ...allProgressQuery(cid, enabled ? client : null),
    select: (rows) => progressIndex(rows).get(`${libraryId}\n${path}`),
    refetchOnMount: false,
  }).data;
}

/**
 * Returns a labeller that names where a result lives: "<server> · <library>".
 * The server is included only when more than one is connected (otherwise it's
 * noise); the library name is resolved from the per-connection library lists.
 * Use it to show the source of a de-duplicated result so "also on/in" makes sense.
 */
export function useSourceLabeller() {
  const apis = useApis();
  const { libraries } = useLibrariesAll();
  const multipleServers = apis.length > 1;
  return (connectionId: string, libraryId: number, connectionName: string): string | undefined => {
    const libName = libraries.find(
      (l) => l.connectionId === connectionId && l.id === libraryId,
    )?.name;
    const parts: string[] = [];
    if (multipleServers) parts.push(connectionName);
    if (libName) parts.push(libName);
    return parts.join(' · ') || undefined;
  };
}

/** One copy of a book: a specific (connection, library, path) with quality hints. */
export type BookCopy = {
  connectionId: string;
  connectionName: string;
  libraryId: number;
  path: string;
  format?: string;
  size?: number;
  multiFile?: boolean;
};

/**
 * Every copy of a given book across all connections and libraries, so the book
 * screen can offer "other versions" to switch to. Found by searching each
 * connection for the title and keeping rows with the same dedup key; expands the
 * server-side other_locations so within-server duplicates are included too.
 */
export function useBookCopies(book: Book | undefined) {
  const apis = useApis();
  const key = book ? bookDedupKey(book) : '';
  const title = book?.title ?? '';
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.copies(connection.id, key),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.search(title, 50, signal),
      enabled: !!book && title.trim().length > 0,
    })),
    combine: (results) => {
      const copies: BookCopy[] = [];
      const seen = new Set<string>();
      results.forEach((r, i) => {
        const conn = apis[i].connection;
        const add = (
          libraryId: number,
          path: string,
          format?: string,
          size?: number,
          multiFile?: boolean,
        ) => {
          const k = contentKey(conn.id, libraryId, path);
          if (seen.has(k)) return;
          seen.add(k);
          copies.push({
            connectionId: conn.id,
            connectionName: conn.name,
            libraryId,
            path,
            format,
            size,
            multiFile,
          });
        };
        for (const b of r.data ?? []) {
          if (bookDedupKey(b) !== key) continue;
          add(b.library_id, b.rel_path, b.format, b.size, b.multi_file ?? undefined);
          for (const ol of b.other_locations ?? []) {
            add(ol.library_id, ol.path, ol.format, ol.size, ol.multi_file);
          }
        }
      });
      return { copies, isLoading: results.some((r) => r.isLoading) };
    },
  });
}

/** Flatten per-connection book lists (a `useQueries` over `apis`) into source-tagged
 * books, for dedup or for "on another server". */
export function tagBooks(
  results: { data?: Book[] }[],
  apis: { connection: { id: string; name: string } }[],
): SourcedBook[] {
  return results.flatMap((r, i) =>
    (r.data ?? []).map((b) => ({
      ...b,
      connectionId: apis[i].connection.id,
      connectionName: apis[i].connection.name,
    })),
  );
}

export type { MergedBook };
