import { type Href, router } from 'expo-router';

import { bookHref, libraryHref, playerHref } from '@/lib/paths';
import { useSession } from '@/stores/session';

/**
 * Navigation that targets a specific connection. The browse/book/player screens
 * operate on the *active* connection, so to open content from another server we
 * switch the active connection first, then route. This keeps the single-server
 * screens, hooks and playback working unchanged while the aggregated Home/Search
 * surfaces span every connection.
 */
export function useOpen() {
  const setActive = useSession((s) => s.setActiveConnection);
  const activeId = useSession((s) => s.activeConnectionId);

  const go = async (connectionId: string, href: Href) => {
    if (connectionId !== activeId) await setActive(connectionId);
    router.push(href);
  };

  return {
    openLibrary: (connectionId: string, libraryId: number, path = '') =>
      go(connectionId, libraryHref(libraryId, path)),
    openBook: (connectionId: string, libraryId: number, path: string) =>
      go(connectionId, bookHref(libraryId, path)),
    openPlayer: (connectionId: string, libraryId: number, path: string) =>
      go(connectionId, playerHref(libraryId, path)),
  };
}
