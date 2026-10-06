import { type Href, router } from 'expo-router';

import {
  authorHref,
  bookHref,
  collectionHref,
  libraryHref,
  narratorHref,
  playerHref,
  seriesHref,
  type SeriesRef,
} from '@/lib/paths';

/**
 * Navigation that targets a specific connection. The connection travels *with* the
 * content as a `?connection=` query param on a flat route (see `paths.ts`), so opening
 * across servers is a plain push - there is no global "active" connection to flip first.
 * The `(app)` layout reads that query param and publishes it to the content hooks below.
 * A push lands in the CURRENT tab (the pushing tab owns the page).
 */
export function useOpen() {
  const go = (href: Href) => router.push(href);

  return {
    openLibrary: (connectionId: string, libraryId: number, path = '') =>
      go(libraryHref(connectionId, libraryId, path)),
    openBook: (connectionId: string, libraryId: number, path: string) =>
      go(bookHref(connectionId, libraryId, path)),
    openPlayer: (connectionId: string, libraryId: number, path: string) =>
      go(playerHref(connectionId, libraryId, path)),
    /** A series page: a local series by `name`, a community one by `work` (see `SeriesRef`). */
    openSeries: (connectionId: string, libraryId: number, ref: SeriesRef) =>
      go(seriesHref(connectionId, libraryId, ref)),
    openAuthor: (connectionId: string, libraryId: number, name: string) =>
      go(authorHref(connectionId, libraryId, name)),
    openNarrator: (connectionId: string, libraryId: number, name: string) =>
      go(narratorHref(connectionId, libraryId, name)),
    openCollection: (connectionId: string, id: number) => go(collectionHref(connectionId, id)),
  };
}
