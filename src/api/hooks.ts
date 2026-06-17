import { useQuery } from '@tanstack/react-query';

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
