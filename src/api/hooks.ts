import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { contentKey } from '@/lib/content-key';
import { bookDedupKey, dedupBooks, type MergedBook, type SourcedBook } from '@/lib/dedup';
import { getDeviceId, mirroredProgress, saveProgress } from '@/playback/progress-sync';

import { ApiError, type ApiClient, type BookListQuery, type BookMetaOptions } from './client';
import { useApi, useApis, useCid, useOptionalApi } from './provider';
import { noteError } from './reachability';
import type { Book, Capabilities, Favourite, Library, Progress } from './types';

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
  seriesList: (cid: string, lib: number) => ['seriesList', cid, lib] as const,
  libraryBooks: (cid: string, lib: number, query: BookListQuery) =>
    ['libraryBooks', cid, lib, query] as const,
  nextBook: (cid: string, lib: number, path: string) => ['nextBook', cid, lib, path] as const,
  allProgress: (cid: string) => ['progress', 'all', cid] as const,
  progress: (cid: string, lib: number, path: string) => ['progress', cid, lib, path] as const,
  bookmarks: (cid: string, lib: number, path: string) => ['bookmarks', cid, lib, path] as const,
  notes: (cid: string, lib: number, path: string) => ['notes', cid, lib, path] as const,
  history: (cid: string, lib: number, path: string) => ['history', cid, lib, path] as const,
  /** Prefix matching every history key of a connection (invalidation). */
  historyAll: (cid: string) => ['history', cid] as const,
  favourites: (connectionId: string) => ['favourites', connectionId] as const,
  apiKeys: (cid: string) => ['apiKeys', cid] as const,
  search: (cid: string, q: string) => ['search', cid, q] as const,
  recent: (cid: string, limit: number) => ['books', 'recent', cid, limit] as const,
  copies: (cid: string, key: string) => ['copies', cid, key] as const,
};

/** The scoped connection's server identity/capabilities (incl. its release version).
 * Resolves via `useCid()` (route scope → active), so the per-connection account screen
 * gets *its* server's version; pass `connectionId` to address a specific connection
 * instead. Tolerates an unconfigured server (returns disabled). */
export function useServerInfo(connectionId?: string) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.server(cid),
    queryFn: ({ signal }) => api!.serverInfo(signal),
    enabled: !!api,
    staleTime: 5 * 60_000, // the server version doesn't change within a session
    // Kept while nothing observes it, so a capability-gated hook mounted later starts
    // from the known flags (refreshed in the background once stale) instead of
    // waiting on another /server round trip.
    gcTime: Infinity,
  });
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
export function useBook(libraryId: number, path: string, connectionId?: string) {
  // Optional (not throwing) client: the player modal renders these hooks OUTSIDE the
  // `(app)` ContentScope guard, so a stale/removed connection id (e.g. tapping an
  // orphaned downloaded book) must yield a disabled query, not a fatal render throw.
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.item(cid, libraryId, path),
    queryFn: ({ signal }) => api!.item(libraryId, path, signal),
    enabled: !!api && path.length > 0,
  });
}

export function useChapters(libraryId: number, path: string, connectionId?: string) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.chapters(cid, libraryId, path),
    queryFn: ({ signal }) => api!.chapters(libraryId, path, signal),
    enabled: !!api && path.length > 0,
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
  const api = useOptionalApi();
  const cid = useCid();
  return useQuery({
    queryKey: qk.bookMeta(cid, libraryId, path, opts),
    queryFn: ({ signal }) => api!.bookMeta(libraryId, path, signal, opts),
    enabled: enabled && !!api && path.length > 0,
    ...(opts?.hideSpoilers ? {} : { staleTime: 60 * 60_000 }),
    retry: false,
  });
}

/** One community-metadata work by its meta-site id, for the "catch up on the
 * previous books" blocks. `enabled` is the caller's "this row is open" flag, so a
 * closed accordion never fetches. Same policy as `useBookMeta`: long `staleTime`
 * and no retry - and an older server (which lacks the route entirely) 404s, which
 * the UI renders as a quiet "couldn't load", never an error banner. */
export function useMetaWork(workId: string, enabled: boolean) {
  const api = useOptionalApi();
  const cid = useCid();
  return useQuery({
    queryKey: qk.metaWork(cid, workId),
    queryFn: ({ signal }) => api!.metaWork(workId, signal),
    enabled: enabled && !!api && workId.length > 0,
    staleTime: 60 * 60_000,
    retry: false,
  });
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
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const supported = useCapability('browse_people', connectionId) === true;
  return useQuery({
    queryKey: queryKey(cid),
    queryFn: supported && api ? ({ signal }) => load(api, signal) : skipToken,
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

/** A library's series with book counts and positions (capability `browse_people`). */
export function useSeriesList(libraryId: number, connectionId?: string) {
  return useBrowseList(
    (cid) => qk.seriesList(cid, libraryId),
    (api, signal) => api.seriesList(libraryId, signal),
    connectionId,
  );
}

/** Page size of `useLibraryBooks` (the server takes 1-200). */
const BOOKS_PAGE_SIZE = 100;

/** A library's indexed books (GET /libraries/{id}/books), page by page on the
 * server's cursor, optionally narrowed by exact `author`/`series`/`narrator` values
 * and sorted. `author`/`series` work on every server; a `narrator` filter needs
 * `browse_people` (an older server ignores it and would answer with the whole
 * library), so with one the query only runs once the server advertises the flag. */
export function useLibraryBooks(
  libraryId: number,
  query: BookListQuery = {},
  connectionId?: string,
) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const narratorOk = useCapability('browse_people', connectionId) === true;
  return useInfiniteQuery({
    queryKey: qk.libraryBooks(cid, libraryId, query),
    queryFn:
      api && (!query.narrator || narratorOk)
        ? ({ pageParam, signal }) =>
            api.listBooks(
              libraryId,
              { ...query, limit: BOOKS_PAGE_SIZE, cursor: pageParam },
              signal,
            )
        : skipToken,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  });
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
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const supported = useCapability('next_book', connectionId) === true;
  return useQuery({
    queryKey: qk.nextBook(cid, libraryId, path),
    queryFn:
      supported && api && path.length > 0
        ? ({ signal }) => api.nextBook(libraryId, path, signal)
        : skipToken,
    enabled,
  });
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
 *    note it against this connection's reachability - same as `loadInitialProgress` -
 *    and serve the mirror so a downloaded book still knows where the listener is.
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
    noteError(connectionId, e);
    return await mirroredProgress(connectionId, libraryId, path);
  }
}

/** Mark a book finished. Goes through the offline-aware last-write-wins save so
 * it reconciles with playback progress, then refreshes the home lists. */
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
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.bookmarks(cid, libraryId, path),
    queryFn: () => api.bookmarks(libraryId, path),
    enabled: path.length > 0,
  });
}

export function useAddBookmark(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { position: number; note?: string }) =>
      api.addBookmark(libraryId, path, vars.position, vars.note ?? ''),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bookmarks(cid, libraryId, path) }),
  });
}

export function useDeleteBookmark(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteBookmark(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bookmarks(cid, libraryId, path) }),
  });
}

// --- Notes -----------------------------------------------------------------
export function useNotes(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.notes(cid, libraryId, path),
    queryFn: () => api.notes(libraryId, path),
    enabled: path.length > 0,
  });
}

export function useAddNote(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { body: string; position?: number }) =>
      api.addNote(libraryId, path, vars.body, vars.position ?? 0),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notes(cid, libraryId, path) }),
  });
}

export function useDeleteNote(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteNote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notes(cid, libraryId, path) }),
  });
}

// --- History ---------------------------------------------------------------
export function useHistory(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.history(cid, libraryId, path),
    queryFn: () => api.history(libraryId, path),
    enabled: path.length > 0,
  });
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

/** Toggle a path's favourite state. Optimistically updates the shared favourites
 * list so the heart and shelf react instantly, then reconciles via invalidation
 * (which fills in server-derived fields like is_book/title for a fresh add). */
export function useToggleFavourite(connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ libraryId, path, on }: { libraryId: number; path: string; on: boolean }) =>
      on ? api.addFavourite(libraryId, path) : api.removeFavourite(libraryId, path),
    onMutate: async ({ libraryId, path, on }) => {
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
          is_book: false,
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
    onSettled: () => qc.invalidateQueries({ queryKey: qk.favourites(cid) }),
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
 * Refreshes this connection's key list on success. */
export function useCreateApiKey(connectionId?: string) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    // The section that fires this only renders under a real connection, so `api` is
    // present in practice; reject defensively if it somehow isn't (the caller surfaces it).
    mutationFn: (label: string) =>
      api ? api.createApiKey(label) : Promise.reject(new Error('no connection')),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apiKeys(cid) }),
  });
}

/** Revoke an API key by id; refreshes this connection's key list on success. */
export function useRevokeApiKey(connectionId?: string) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api ? api.revokeApiKey(id) : Promise.reject(new Error('no connection')),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apiKeys(cid) }),
  });
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

export function useLibrariesAll() {
  const apis = useApis();
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.libraries(connection.id),
      queryFn: () => client.libraries(),
    })),
    combine: (results) => ({
      libraries: results.flatMap((r, i) =>
        (r.data ?? []).map((l): SourcedLibrary => ({
          ...l,
          connectionId: apis[i].connection.id,
          connectionName: apis[i].connection.name,
        })),
      ),
      isLoading: results.some((r) => r.isLoading),
      error: results.find((r) => r.error)?.error ?? null,
    }),
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
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.search(connection.id, q),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.search(q, 50, signal),
      enabled: q.length > 0,
    })),
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
      queryKey: qk.allProgress(connection.id),
      queryFn: () => client.allProgress(),
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

/** Flatten per-connection book lists into source-tagged books for dedup. */
function tagBooks(
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
