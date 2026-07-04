import { type Href, router } from 'expo-router';

import { bookHref, libraryHref, playerHref } from '@/lib/paths';

/**
 * Navigation that targets a specific connection. The connection travels *with* the
 * content in the route (`/s/<cid>/…`), so opening across servers is a plain push -
 * there is no global "active" connection to flip first. The `s/[connectionId]` route
 * layout publishes the connection to the content hooks underneath.
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
