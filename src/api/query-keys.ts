import { READALONG_ALIGN } from '@/lib/bridge-jobs';
import { serverInfoKey } from '@/lib/auth-failure';

import type { BookListQuery, BookMetaOptions } from './client';
import type { PodcastEpisodeOrder, StatsRange } from './types';

/** Centralized query keys so mutations can invalidate precisely. Every key leads with
 * the connection id (`cid`) so two servers with the same (libraryId, path) never share
 * a cache entry; the shape is unified with the cross-connection fan-out hooks below so
 * the single- and multi-server views share one cache. */
export const qk = {
  server: serverInfoKey,
  libraries: (cid: string) => ['libraries', cid] as const,
  /** Every folder listing of a library (a prefix of `browse`: whatever its path). */
  folders: (cid: string, lib: number) => ['browse', cid, lib] as const,
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
  /** Every series list of a library (a prefix of `seriesList`: both variants). */
  seriesLists: (cid: string, lib: number) => ['seriesList', cid, lib] as const,
  /** `memberships`: counted in every series a book is in (`series_memberships`). */
  seriesList: (cid: string, lib: number, memberships: boolean) =>
    ['seriesList', cid, lib, { memberships }] as const,
  /** Every book list of a library (a prefix of `libraryBooks`: whatever its query). */
  libraryBookLists: (cid: string, lib: number) => ['libraryBooks', cid, lib] as const,
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
  /** Every recently added list of a connection (a prefix of `recent`: whatever its limit). */
  recentLists: (cid: string) => ['books', 'recent', cid] as const,
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
  /** The caller's upcoming releases, capability `upcoming` (Track U2). */
  upcoming: (cid: string) => ['upcoming', cid] as const,
  /** Whether the caller has a calendar link, capability `upcoming_calendar` (Track U3). */
  upcomingCalendar: (cid: string) => ['upcomingCalendar', cid] as const,
  /** This device's copy of that link (the secure store, never the network: Track U3). */
  upcomingCalendarLink: (cid: string) => ['upcomingCalendarLink', cid] as const,
  /** The car's Library tab: a library's newest books, one page (`src/car`). */
  carLibrary: (cid: string, lib: number) => ['car', 'library', cid, lib] as const,
  // The Bridge, capability `bridge` (admin only; Bridge Phase 1a).
  /** A book's Bridge jobs, by its own path (`rel_path`). */
  bridgeJobs: (cid: string, lib: number, path: string) => ['bridgeJobs', cid, lib, path] as const,
  /** What generating characters and recaps for a book would take. */
  bridgeEstimate: (cid: string, lib: number, path: string) =>
    ['bridgeEstimate', cid, lib, path] as const,
  /** What making a book's read-along would take (Bridge Phase 3c): under `bridgeEstimate`,
   * so a refused queue reads both again. */
  readalongEstimate: (cid: string, lib: number, path: string) =>
    ['bridgeEstimate', cid, lib, path, READALONG_ALIGN] as const,
  /** A book's read-along map (capability `readalong`, Bridge Phase 3c), per map: keyed by
   * its `generated_at` (`Book.readalong`), so a map made again is fetched again. */
  readalong: (cid: string, lib: number, path: string, generatedAt: string) =>
    ['readalong', cid, lib, path, generatedAt] as const,
  /** The read-along map a download keeps (`readalong.json`), read from the device, per map
   * (its `generated_at`). */
  readalongLocal: (cid: string, lib: number, path: string, generatedAt: string) =>
    ['readalongLocal', cid, lib, path, generatedAt] as const,
  /** One Bridge job by its id: how a job about no book (a `librivox.fetch`) is followed. */
  bridgeJob: (cid: string, id: number) => ['bridgeJob', cid, id] as const,
  // Add from LibriVox (LibriVox L6; admin only).
  /** A LibriVox search, by its trimmed query. */
  librivoxSearch: (cid: string, q: string) => ['librivoxSearch', cid, q] as const,
  /** Every LibriVox work of a connection (a prefix: an Add or a job's end asks them again). */
  librivoxWorks: (cid: string) => ['librivoxWork', cid] as const,
  /** One work's LibriVox recordings, under `librivoxWorks`. */
  librivoxWork: (cid: string, id: string) => ['librivoxWork', cid, id] as const,
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
