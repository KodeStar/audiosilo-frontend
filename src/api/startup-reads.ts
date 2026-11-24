import {
  hashKey,
  infiniteQueryOptions,
  queryOptions,
  skipToken,
  type FetchQueryOptions,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';

import { isKeptOffline } from '@/downloads/kept-offline';
import { progressToSave, writeMirrors } from '@/playback/progress-sync';
import { rememberLibraryNames } from '@/stores/library-names';
import { isRecord } from '@/lib/storage-keys';

import type { ApiClient, BookListQuery } from './client';
import { qk } from './query-keys';
import type { BookPage, Capabilities, Library, Progress, StatsRange } from './types';

type MaybeClient = ApiClient | null | undefined;
type Page = 'shell' | 'homeAndLibrary' | 'home' | 'library';
type StartupMeta = {
  startup: true;
  page?: Page;
  capability?: keyof Capabilities;
  owner?: 'default' | 'queue';
};
const STARTUP = { startup: true } as const;
export const RECENT_LIMIT = 48;
const STATS_HOME_RANGE = '30d';
const LISTENING_HOME_RANGE = '1y';
export const BOOKS_PAGE_SIZE = 100;
const WHOLE_LIBRARY_ORDER = { sort: 'recent' } as const;
const WHOLE_LIBRARY_SIZE = 200;
const WHOLE_LIBRARY_STALE_MS = 10 * 60_000;

export type StartupRead = {
  queryKey: QueryKey;
  meta?: StartupMeta;
  ask: (client: QueryClient) => Promise<void>;
};

function read<T, K extends QueryKey>(options: FetchQueryOptions<T, Error, T, K>): StartupRead {
  return {
    queryKey: options.queryKey,
    meta: options.meta as StartupMeta | undefined,
    ask: (qc) => qc.prefetchQuery(options),
  };
}

type ReadInputs = {
  cid: string;
  api: MaybeClient;
  libraryId: number;
  memberships: boolean;
  recentLimit: number;
};

const factories: ((inputs: ReadInputs) => StartupRead)[] = [];

/** A callable query spec for the hook, with its first-screen arguments known to
 * the gate and the storage reader. The returned function keeps its tagged key. */
function declareRead<F>(make: F, prepare: (inputs: ReadInputs, make: F) => StartupRead): F {
  factories.push((values) => prepare(values, make));
  return make;
}

function onConnection<T, K extends QueryKey>(
  { cid, api }: ReadInputs,
  make: (cid: string, api: MaybeClient) => FetchQueryOptions<T, Error, T, K>,
) {
  return read(make(cid, api));
}

function inLibrary<T, K extends QueryKey>(
  { cid, api, libraryId }: ReadInputs,
  make: (cid: string, api: MaybeClient, lib: number) => FetchQueryOptions<T, Error, T, K>,
) {
  return read(make(cid, api, libraryId));
}

/** `/server`: the version and flags don't change within a session. Kept while nothing
 * observes it, so a capability-gated hook mounted later starts from the known flags
 * (refreshed in the background once stale) instead of waiting on another round trip. */
export const serverInfoQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.server(cid),
      meta: { ...STARTUP, page: 'shell' } satisfies StartupMeta,
      queryFn: client ? ({ signal }) => client.serverInfo(signal) : skipToken,
      // A dependent screen mounting after a failure must not restart every other gate.
      // Retry, reconnect and a new sign-in still ask again.
      retryOnMount: false,
      // TanStack uses refetchOnMount when a failed re-read holds an older answer.
      refetchOnMount: (query) => query.state.status !== 'error',
      staleTime: 5 * 60_000,
      gcTime: Infinity,
    }),
  onConnection,
);

/** The caller's own signed-in devices (`GET /me/devices`). Ask only a server with
 * `my_devices` (pass no client otherwise). Read after a password change by
 * `useReadMyDevicesAgain`; `useMyDevices` reads the same key through `useCapabilityQuery`. */
export const myDevicesQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.myDevices(cid),
      meta: STARTUP,
      queryFn: client ? ({ signal }) => client.myDevices(signal) : skipToken,
    }),
  onConnection,
);

/** A server's libraries, their names kept on the device as they arrive (an offline book
 * page names its library: `useLibraryName`, PLAYER-09). Every read of `qk.libraries` asks
 * through `librariesQuery`. */
export async function fetchLibraries(cid: string, client: ApiClient): Promise<Library[]> {
  const libraries = await client.libraries();
  rememberLibraryNames(cid, libraries);
  return libraries;
}

/** A server's libraries. */
export const librariesQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.libraries(cid),
      meta: { ...STARTUP, page: 'shell' } satisfies StartupMeta,
      queryFn: client ? () => fetchLibraries(cid, client) : skipToken,
    }),
  onConnection,
);

/** The caller's collections (their own and those shared with them). Ask only a server
 * with `collections`. */
export const collectionsQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.collections(cid),
      meta: STARTUP,
      queryFn: client ? ({ signal }) => client.collections(signal) : skipToken,
    }),
  onConnection,
);

/** The Up next queue. Ask only a server with `queue`. */
export const queueQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.queue(cid),
      meta: { ...STARTUP, page: 'home', capability: 'queue', owner: 'queue' } satisfies StartupMeta,
      queryFn: client ? ({ signal }) => client.queue(signal) : skipToken,
    }),
  onConnection,
);

/** A server's newest books (Home's Recently added). */
export const recentQuery = declareRead(
  (cid: string, client: MaybeClient, limit: number = RECENT_LIMIT) =>
    queryOptions({
      queryKey: qk.recent(cid, limit),
      meta: (limit === RECENT_LIMIT ? { ...STARTUP, page: 'home' } : STARTUP) satisfies StartupMeta,
      queryFn: client ? ({ signal }) => client.recentBooks(limit, signal) : skipToken,
    }),
  ({ cid, api, recentLimit }, make) => read(make(cid, api, recentLimit)),
);

/** The caller's favourites on a server. */
export const favouritesQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.favourites(cid),
      meta: { ...STARTUP, page: 'home' } satisfies StartupMeta,
      queryFn: client ? ({ signal }) => client.favourites(signal) : skipToken,
    }),
  onConnection,
);

/** Every saved progress row of a connection. The rows of books downloaded here go into the
 * durable mirror as they come (`keepDownloadedPlaces`). */
export const allProgressQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.allProgress(cid),
      meta: { ...STARTUP, page: 'homeAndLibrary' } satisfies StartupMeta,
      queryFn: client
        ? async () => {
            const rows = await client.allProgress();
            void keepDownloadedPlaces(cid, rows);
            return rows;
          }
        : skipToken,
    }),
  onConnection,
);

/**
 * Put the server's rows of the books downloaded on this device into the durable mirror, in
 * one write (keep-newest, so a newer save of this device's own stays), as
 * `fetchBookProgress` does for one book: an offline resume of a downloaded book then knows
 * another device's newer place even when its page was not opened before going offline
 * (fe#198). Never fails the list.
 */
async function keepDownloadedPlaces(cid: string, rows: readonly Progress[]): Promise<void> {
  try {
    const kept = rows.filter((r) => isKeptOffline(cid, r.library_id, r.path));
    if (kept.length === 0) return;
    await writeMirrors(kept.map((r) => progressToSave(cid, r.library_id, r.path, r)));
  } catch {
    // The list stands without it: a downloaded book's page and resume still mirror it.
  }
}

/** A library list (`useLibraryBooks`), page by page on the server's cursor, through
 * `listBooks`; a page size other than the default is its own cache entry. */
export function libraryBooksQuery(
  cid: string,
  client: MaybeClient,
  libraryId: number,
  query: BookListQuery,
  pageSize: number = BOOKS_PAGE_SIZE,
) {
  const key = qk.libraryBooks(cid, libraryId, query);
  const queryKey = pageSize === BOOKS_PAGE_SIZE ? key : [...key, { pageSize }];
  return infiniteQueryOptions({
    queryKey,
    queryFn: client
      ? ({ pageParam, signal }) =>
          client.listBooks(libraryId, { ...query, limit: pageSize, cursor: pageParam }, signal)
      : skipToken,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: BookPage) => lastPage.next_cursor || undefined,
  });
}

/** `/me/stats` for a period as query options, for a reader that fetches it itself (the
 * Year section's search for earlier years): the cache entry `useMyStats` reads. The caller
 * checks `user_stats` first. */
export const myStatsQuery = declareRead(
  (cid: string, client: MaybeClient, range: StatsRange) =>
    queryOptions({
      queryKey: qk.myStats(cid, range),
      meta: (range === STATS_HOME_RANGE
        ? { ...STARTUP, page: 'home', capability: 'user_stats' }
        : undefined) satisfies StartupMeta | undefined,
      queryFn: client ? ({ signal }) => client.myStats(range, signal) : skipToken,
    }),
  ({ cid, api }, make) => read(make(cid, api, STATS_HOME_RANGE)),
);

export const myListeningQuery = declareRead(
  (cid: string, client: MaybeClient, range: StatsRange) =>
    queryOptions({
      queryKey: qk.myListening(cid, range),
      meta: (range === LISTENING_HOME_RANGE
        ? { ...STARTUP, page: 'home', capability: 'user_stats', owner: 'default' }
        : undefined) satisfies StartupMeta | undefined,
      queryFn: client ? ({ signal }) => client.myListening(range, signal) : skipToken,
    }),
  ({ cid, api }, make) => read(make(cid, api, LISTENING_HOME_RANGE)),
);

export const listeningGoalQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.listeningGoal(cid),
      meta: {
        ...STARTUP,
        page: 'home',
        capability: 'user_stats',
        owner: 'default',
      } satisfies StartupMeta,
      queryFn: client ? ({ signal }) => client.listeningGoal(signal) : skipToken,
    }),
  onConnection,
);

export const householdQuery = declareRead(
  (cid: string, client: MaybeClient) =>
    queryOptions({
      queryKey: qk.household(cid),
      meta: { ...STARTUP, page: 'home', capability: 'household' } satisfies StartupMeta,
      queryFn: client ? ({ signal }) => client.household(signal) : skipToken,
      staleTime: Infinity,
    }),
  onConnection,
);

/** Readers share these options with the cold start. The metadata on each option
 * chooses its page, connection and capability. Cache-only reads have no page. */
export function startupReads(
  cid: string,
  api: MaybeClient,
  libraryId: number,
  memberships = false,
  recentLimit = RECENT_LIMIT,
): StartupRead[] {
  const inputs = { cid, api, libraryId, memberships, recentLimit };
  return factories.map((make) => make(inputs));
}

export const wholeLibraryQuery = declareRead(
  (cid: string, client: MaybeClient, libraryId: number) => ({
    ...libraryBooksQuery(cid, client, libraryId, WHOLE_LIBRARY_ORDER, WHOLE_LIBRARY_SIZE),
    meta: { ...STARTUP, page: 'library' } satisfies StartupMeta,
    staleTime: WHOLE_LIBRARY_STALE_MS,
  }),
  ({ cid, api, libraryId }, make) => {
    const options = make(cid, api, libraryId);
    return {
      queryKey: options.queryKey,
      meta: options.meta as StartupMeta,
      ask: (qc) => qc.prefetchInfiniteQuery(options),
    };
  },
);

export const authorsQuery = declareRead(
  (cid: string, client: MaybeClient, lib: number) =>
    ({
      queryKey: qk.authors(cid, lib),
      meta: STARTUP,
      queryFn: client
        ? ({ signal }: { signal: AbortSignal }) => client.authors(lib, signal)
        : skipToken,
    }) as const,
  inLibrary,
);

export const narratorsQuery = declareRead(
  (cid: string, client: MaybeClient, lib: number) =>
    ({
      queryKey: qk.narrators(cid, lib),
      meta: STARTUP,
      queryFn: client
        ? ({ signal }: { signal: AbortSignal }) => client.narrators(lib, signal)
        : skipToken,
    }) as const,
  inLibrary,
);

export const seriesListQuery = declareRead(
  (cid: string, client: MaybeClient, lib: number, memberships: boolean) =>
    ({
      queryKey: qk.seriesList(cid, lib, memberships),
      meta: STARTUP,
      queryFn: client
        ? ({ signal }: { signal: AbortSignal }) => client.seriesList(lib, { memberships }, signal)
        : skipToken,
    }) as const,
  ({ cid, api, libraryId, memberships }, make) => read(make(cid, api, libraryId, memberships)),
);

let storedByHead: Map<unknown, typeof factories> | undefined;

/** A stored document carries keys alone. Index the factories by the head of their
 * own key on the first lookup, so an unmarked seed (for example an item) costs no
 * query options to reject. More than one spec can share a head. */
function storedFactories(head: unknown, inputs: ReadInputs) {
  if (!storedByHead) {
    storedByHead = new Map();
    for (const make of factories) {
      const [name] = make(inputs).queryKey;
      const list = storedByHead.get(name);
      if (list) list.push(make);
      else storedByHead.set(name, [make]);
    }
  }
  return storedByHead.get(head);
}

/** Storage carries JSON, and a manually seeded answer has no React Query options.
 * Recognise only keys a marked spec actually emits, including its range and page size. */
export function startupMeta(key: QueryKey): StartupMeta | undefined {
  const [, second, third, fourth] = key;
  const cid = key[0] === qk.allProgressAll()[0] || key[0] === qk.recentAll()[0] ? third : second;
  if (typeof cid !== 'string' || !cid) return undefined;
  const lib = typeof third === 'number' ? third : 0;
  const memberships = isRecord(fourth) && fourth.memberships === true;
  const limit = typeof fourth === 'number' ? fourth : RECENT_LIMIT;
  const inputs = { cid, api: null, libraryId: lib, memberships, recentLimit: limit };
  const candidates = storedFactories(key[0], inputs);
  if (!candidates) return undefined;
  const hash = hashKey(key);
  for (const make of candidates) {
    const spec = make(inputs);
    if (hashKey(spec.queryKey) === hash) return spec.meta;
  }
  return undefined;
}
