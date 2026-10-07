import { type Href, router } from 'expo-router';

import {
  authorHref,
  bookHref,
  type BookPlace,
  type BookTab,
  collectionHref,
  libraryHref,
  narratorHref,
  playerHref,
  seriesHref,
  type SeriesRef,
} from '@/lib/paths';
import { currentNavState, type NavState, shellUnderTop } from '@/lib/root-stack';

/** `href` inside the tab group `tab` (`/book/1` -> `/(library)/book/1`). */
function inTab(href: Href, tab: string): Href {
  if (typeof href === 'string') return (href.startsWith('/') ? `/${tab}${href}` : href) as Href;
  return { ...href, pathname: `/${tab}${href.pathname}` } as Href;
}

/**
 * Push a page of the app shell (a book, a series, a library folder...). From a shell page
 * a plain push, into the current tab. From a root route over the shell (the full player,
 * the credits) it first dismisses those, then pushes into the shell's active tab: a push
 * or a replace from there would stack a second `(app)` shell over the first (two docks,
 * two sheet hosts, every keyboard shortcut firing twice). The tab is named in the href
 * because expo-router picks the tab from the route it is leaving, and the player is in
 * none (it would land in Home).
 */
export function pushInShell(href: Href, state: NavState | undefined = currentNavState()) {
  const shell = shellUnderTop(state);
  if (!shell || shell.above === 0) {
    router.push(href);
    return;
  }
  router.dismiss(shell.above);
  if (shell.tab) router.push(inTab(href, shell.tab));
  else router.push(href, { withAnchor: true });
}

/**
 * Navigation that targets a specific connection. The connection travels *with* the
 * content as a `?connection=` query param on a flat route (see `paths.ts`), so opening
 * across servers is a plain push - there is no global "active" connection to flip first.
 * The `(app)` layout reads that query param and publishes it to the content hooks below.
 * A push lands in the CURRENT tab (the pushing tab owns the page); from over the full
 * player or the credits it lands in the shell underneath (`pushInShell`).
 */
export function useOpen() {
  const go = (href: Href) => pushInShell(href);

  return {
    openLibrary: (connectionId: string, libraryId: number, path = '') =>
      go(libraryHref(connectionId, libraryId, path)),
    /** A book page, on `tab` when given (see `parseBookTab`). */
    openBook: (connectionId: string, libraryId: number, path: string, tab?: BookTab) =>
      go(bookHref(connectionId, libraryId, path, tab)),
    // A root route of its own, never inside the shell. At `place` when given.
    openPlayer: (connectionId: string, libraryId: number, path: string, place?: BookPlace) =>
      router.push(playerHref(connectionId, libraryId, path, place)),
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
