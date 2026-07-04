import { type Href, router } from 'expo-router';

import { bookHref, libraryHref, playerHref } from '@/lib/paths';

/**
 * Navigation that targets a specific connection. The connection travels *with* the
 * content as a `?connection=` query param on a flat route (see `paths.ts`), so opening
 * across servers is a plain push - there is no global "active" connection to flip first.
 * The `(app)` layout reads that query param and publishes it to the content hooks below.
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
  };
}
