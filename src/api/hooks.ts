import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { contentKey } from '@/lib/content-key';
import { bookDedupKey, dedupBooks, type MergedBook, type SourcedBook } from '@/lib/dedup';
import { getDeviceId, saveProgress } from '@/playback/progress-sync';

import { useApi, useApis, useCid, useOptionalApi } from './provider';
import type { Book, Favourite, Library, Progress } from './types';

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
  allProgress: (cid: string) => ['progress', 'all', cid] as const,
  progress: (cid: string, lib: number, path: string) => ['progress', cid, lib, path] as const,
  bookmarks: (cid: string, lib: number, path: string) => ['bookmarks', cid, lib, path] as const,
  notes: (cid: string, lib: number, path: string) => ['notes', cid, lib, path] as const,
  history: (cid: string, lib: number, path: string) => ['history', cid, lib, path] as const,
  /** Prefix matching every history key of a connection (invalidation). */
  historyAll: (cid: string) => ['history', cid] as const,
  favourites: (connectionId: string) => ['favourites', connectionId] as const,
  search: (cid: string, q: string) => ['search', cid, q] as const,
  recent: (cid: string, limit: number) => ['books', 'recent', cid, limit] as const,
  copies: (cid: string, key: string) => ['copies', cid, key] as const,
};

/** The scoped connection's server identity/capabilities (incl. its release version).
 * Resolves via `useCid()` (route scope → active), so the per-connection account screen
 * gets *its* server's version. Tolerates an unconfigured server (returns disabled). */
export function useServerInfo() {
  const api = useOptionalApi();
  const cid = useCid();
  return useQuery({
    queryKey: qk.server(cid),
    queryFn: ({ signal }) => api!.serverInfo(signal),
    enabled: !!api,
    staleTime: 5 * 60_000, // the server version doesn't change within a session
  });
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
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.item(cid, libraryId, path),
    queryFn: ({ signal }) => api.item(libraryId, path, signal),
    enabled: path.length > 0,
  });
}

export function useChapters(libraryId: number, path: string, connectionId?: string) {
  const api = useApi(connectionId);
  const cid = useCid(connectionId);
  return useQuery({
    queryKey: qk.chapters(cid, libraryId, path),
    queryFn: ({ signal }) => api.chapters(libraryId, path, signal),
    enabled: path.length > 0,
  });
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
        (r.data ?? []).map(
          (l): SourcedLibrary => ({
            ...l,
            connectionId: apis[i].connection.id,
            connectionName: apis[i].connection.name,
          }),
        ),
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
        (r.data ?? []).map(
          (f): SourcedFavourite => ({
            ...f,
            connectionId: apis[i].connection.id,
            connectionName: apis[i].connection.name,
          }),
        ),
      ),
      isLoading: results.some((r) => r.isLoading),
      error: results.find((r) => r.error)?.error ?? null,
    }),
  });
}

export function useAllProgressAll() {
  const apis = useApis();
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.allProgress(connection.id),
      queryFn: () => client.allProgress(),
    })),
    combine: (results) => ({
      // Newest first across all connections (no cross-connection merge yet).
      progress: results
        .flatMap((r, i) =>
          (r.data ?? []).map(
            (p): SourcedProgress => ({
              ...p,
              connectionId: apis[i].connection.id,
              connectionName: apis[i].connection.name,
            }),
          ),
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
