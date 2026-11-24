import type { Favourite } from './types';

/** Whether `f` is the favourite of `path` in library `libraryId`: the one rule the favourite
 * toggle (`useToggleFavourite`), the book page's heart and the folder rows' hearts match by. */
export function isFavouriteOf(
  f: Pick<Favourite, 'library_id' | 'path'>,
  libraryId: number,
  path: string,
): boolean {
  return f.library_id === libraryId && f.path === path;
}
