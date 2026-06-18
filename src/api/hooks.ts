import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from './provider';

/** Centralized query keys so mutations can invalidate precisely. */
export const qk = {
  libraries: () => ['libraries'] as const,
  browse: (lib: number, path: string) => ['browse', lib, path] as const,
  item: (lib: number, path: string) => ['item', lib, path] as const,
  chapters: (lib: number, path: string) => ['chapters', lib, path] as const,
  search: (q: string) => ['search', q] as const,
  allProgress: () => ['progress', 'all'] as const,
  progress: (lib: number, path: string) => ['progress', lib, path] as const,
  bookmarks: (lib: number, path: string) => ['bookmarks', lib, path] as const,
  notes: (lib: number, path: string) => ['notes', lib, path] as const,
  history: (lib: number, path: string) => ['history', lib, path] as const,
  allHistory: () => ['history', 'all'] as const,
};

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

export function useAllProgress() {
  const api = useApi();
  return useQuery({ queryKey: qk.allProgress(), queryFn: () => api.allProgress() });
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
