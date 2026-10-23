import type { Library } from '@/api/types';

/** Whether a library holds podcast shows (Bridge Phase 2c). An absent or unknown kind is
 * books: an older server sends none, a newer one may send a kind this build doesn't know. */
export function isPodcastLibrary(l: Pick<Library, 'kind'>): boolean {
  return l.kind === 'podcasts';
}

/** The ids of the podcast libraries in a list: an episode row is told by its library's
 * kind, since list and progress shapes carry no `episode` (Bridge Phase 2d-1). */
export function podcastLibraryIds(libraries: readonly Pick<Library, 'id' | 'kind'>[]): Set<number> {
  return new Set(libraries.filter(isPodcastLibrary).map((l) => l.id));
}

/** The libraries kids mode may show: no podcast libraries (Bridge Phase 2d-1, decision
 * 6.2). Both the kids screen and the kids library picker read this. */
export function kidsLibraries<L extends Pick<Library, 'kind'>>(libraries: readonly L[]): L[] {
  return libraries.filter((l) => !isPodcastLibrary(l));
}
