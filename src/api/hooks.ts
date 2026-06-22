import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { dedupBooks, type MergedBook, type SourcedBook } from '@/lib/dedup';
import { getDeviceId, saveProgress } from '@/playback/progress-sync';

import { useApi, useApis, useOptionalApi } from './provider';
import type { Book, Favourite, Library, Progress } from './types';

/** Centralized query keys so mutations can invalidate precisely. */
export const qk = {
  server: () => ['server'] as const,
  libraries: () => ['libraries'] as const,
  browse: (lib: number, path: string) => ['browse', lib, path] as const,
  item: (lib: number, path: string) => ['item', lib, path] as const,
  chapters: (lib: number, path: string) => ['chapters', lib, path] as const,
  search: (q: string) => ['search', q] as const,
  recentBooks: (limit: number) => ['books', 'recent', limit] as const,
  allProgress: () => ['progress', 'all'] as const,
  progress: (lib: number, path: string) => ['progress', lib, path] as const,
  bookmarks: (lib: number, path: string) => ['bookmarks', lib, path] as const,
  notes: (lib: number, path: string) => ['notes', lib, path] as const,
  history: (lib: number, path: string) => ['history', lib, path] as const,
  allHistory: () => ['history', 'all'] as const,
  favourites: () => ['favourites', 'all'] as const,
};

/** The connected server's identity/capabilities (incl. its release version).
 * Tolerates an unconfigured server (returns disabled) so it is safe in chrome
 * like the sidebar that can render before/without a connection. */
export function useServerInfo() {
  const api = useOptionalApi();
  return useQuery({
    queryKey: qk.server(),
    queryFn: ({ signal }) => api!.serverInfo(signal),
    enabled: !!api,
    staleTime: 5 * 60_000, // the server version doesn't change within a session
  });
}

export function useLibraries() {
  const api = useApi();
  return useQuery({ queryKey: qk.libraries(), queryFn: () => api.libraries() });
}

export function useBrowse(libraryId: number, path: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.browse(libraryId, path),
    queryFn: ({ signal }) => api.browse(libraryId, path, 0, 200, signal),
  });
}

export function useBook(libraryId: number, path: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.item(libraryId, path),
    queryFn: ({ signal }) => api.item(libraryId, path, signal),
    enabled: path.length > 0,
  });
}

export function useChapters(libraryId: number, path: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.chapters(libraryId, path),
    queryFn: ({ signal }) => api.chapters(libraryId, path, signal),
    enabled: path.length > 0,
  });
}

export function useSearch(query: string) {
  const api = useApi();
  const q = query.trim();
  return useQuery({
    queryKey: qk.search(q),
    queryFn: ({ signal }) => api.search(q, 50, signal),
    enabled: q.length > 0,
  });
}

/** Recently added books across every accessible library, merged and sorted by
 * the server (one cross-library call — no per-library fan-out). */
export function useRecentBooks(limit = 48) {
  const api = useApi();
  return useQuery({
    queryKey: qk.recentBooks(limit),
    queryFn: ({ signal }) => api.recentBooks(limit, signal),
  });
}

export function useAllProgress() {
  const api = useApi();
  return useQuery({ queryKey: qk.allProgress(), queryFn: () => api.allProgress() });
}

/** Mark a book finished. Goes through the offline-aware last-write-wins save so
 * it reconciles with playback progress, then refreshes the home lists. */
export function useMarkFinished() {
  const api = useApi();
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
      qc.invalidateQueries({ queryKey: qk.allProgress() });
      qc.invalidateQueries({ queryKey: qk.progress(p.libraryId, p.path) });
    },
  });
}

// --- Bookmarks -------------------------------------------------------------
export function useBookmarks(libraryId: number, path: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.bookmarks(libraryId, path),
    queryFn: () => api.bookmarks(libraryId, path),
    enabled: path.length > 0,
  });
}

export function useAddBookmark(libraryId: number, path: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { position: number; note?: string }) =>
      api.addBookmark(libraryId, path, vars.position, vars.note ?? ''),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bookmarks(libraryId, path) }),
  });
}

export function useDeleteBookmark(libraryId: number, path: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteBookmark(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bookmarks(libraryId, path) }),
  });
}

// --- Notes -----------------------------------------------------------------
export function useNotes(libraryId: number, path: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.notes(libraryId, path),
    queryFn: () => api.notes(libraryId, path),
    enabled: path.length > 0,
  });
}

export function useAddNote(libraryId: number, path: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { body: string; position?: number }) =>
      api.addNote(libraryId, path, vars.body, vars.position ?? 0),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notes(libraryId, path) }),
  });
}

export function useDeleteNote(libraryId: number, path: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteNote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notes(libraryId, path) }),
  });
}

// --- History ---------------------------------------------------------------
export function useHistory(libraryId: number, path: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.history(libraryId, path),
    queryFn: () => api.history(libraryId, path),
    enabled: path.length > 0,
  });
}

// --- Favourites ------------------------------------------------------------
/** The caller's favourites across every accessible library (one cross-library
 * call). Feeds the per-row hearts, the Favourites shelf, and the home section. */
export function useFavourites() {
  const api = useApi();
  return useQuery({ queryKey: qk.favourites(), queryFn: ({ signal }) => api.favourites(signal) });
}

/** Toggle a path's favourite state. Optimistically updates the shared favourites
 * list so the heart and shelf react instantly, then reconciles via invalidation
 * (which fills in server-derived fields like is_book/title for a fresh add). */
export function useToggleFavourite() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ libraryId, path, on }: { libraryId: number; path: string; on: boolean }) =>
      on ? api.addFavourite(libraryId, path) : api.removeFavourite(libraryId, path),
    onMutate: async ({ libraryId, path, on }) => {
      await qc.cancelQueries({ queryKey: qk.favourites() });
      const prev = qc.getQueryData<Favourite[]>(qk.favourites());
      qc.setQueryData<Favourite[]>(qk.favourites(), (cur) => {
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
      if (ctx?.prev) qc.setQueryData(qk.favourites(), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.favourites() }),
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
      queryKey: ['libraries', connection.id] as const,
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
      queryKey: ['search', connection.id, q] as const,
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
      queryKey: ['books', 'recent', connection.id, limit] as const,
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
      queryKey: ['favourites', connection.id] as const,
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
      queryKey: ['progress', 'all', connection.id] as const,
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
