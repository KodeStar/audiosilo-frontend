import type { Library } from '@/api/types';

/** Whether a library holds podcast shows (Bridge Phase 2c). An absent or unknown kind is
 * books: an older server sends none, a newer one may send a kind this build doesn't know. */
export function isPodcastLibrary(l: Pick<Library, 'kind'>): boolean {
  return l.kind === 'podcasts';
}

/** The libraries kids mode may show: no podcast libraries (Bridge Phase 2d-1, decision
 * 6.2). Both the kids screen and the kids library picker read this. */
export function kidsLibraries<L extends Pick<Library, 'kind'>>(libraries: readonly L[]): L[] {
  return libraries.filter((l) => !isPodcastLibrary(l));
}
