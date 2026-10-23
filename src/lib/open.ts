import { type Href, router } from 'expo-router';

import {
  authorHref,
  bookHref,
  type BookPlace,
  type BookTab,
  collectionHref,
  type CoreYouSection,
  findShowsHref,
  type FindShowsSection,
  householdHref,
  type JournalTab,
  libraryHref,
  narratorHref,
  playerHref,
  podcastShowHref,
  seriesHref,
  type SeriesRef,
  settingsHref,
  type SettingsSection,
  youHref,
} from '@/lib/paths';
import {
  currentNavState,
  focusedRoute,
  type NavState,
  popTabToRoot,
  shellUnderTop,
} from '@/lib/root-stack';

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

/** The Me tab's group: its root is the You hub. */
const ME_TAB = '(me)';
/** The Library tab's group: its root is the browse modes. */
const LIBRARY_TAB = '(library)';

/**
 * Open `href`, a tab's ROOT with its params (the You hub on a section), as THAT tab's root:
 * close the full player or the credits over the shell, pop the tab's stack back to its
 * root, then navigate there, which switches to the tab and gives the root the href's
 * params. A plain push or navigate would put a second copy of the root on the tab's stack
 * when it holds pages (a navigate is a push in this router), and `inTab` would look for
 * the root in the current tab, where it doesn't exist.
 */
function openTabRoot(href: Href, tab: string, state: NavState | undefined) {
  const shell = shellUnderTop(state);
  if (shell && shell.above > 0) router.dismiss(shell.above);
  popTabToRoot(tab, state);
  router.navigate(href);
}

/** The You hub (the Me tab's root) on `section`, with the Journal's `tab`. */
export function openYou(
  section?: CoreYouSection,
  journalTab?: JournalTab,
  state: NavState | undefined = currentNavState(),
) {
  openTabRoot(youHref(section, journalTab), ME_TAB, state);
}

/**
 * The Library tab's root at `href` (a browse mode, or the Books mode's sort and filters:
 * `libraryBooksHref`), as that tab's root, from anywhere (a book page in any tab).
 */
export function openLibraryRoot(href: Href, state: NavState | undefined = currentNavState()) {
  openTabRoot(href, LIBRARY_TAB, state);
}

/** The Journal (across every server): the You hub's Journal section, on `tab`. */
export function openJournal(tab?: JournalTab, state: NavState | undefined = currentNavState()) {
  openYou('journal', tab, state);
}

/**
 * Settings, on `section` when given (the top bar's gear, the profile menu, the palette).
 * A page pushed on the current tab, so back returns where the listener was; on the
 * Settings page already, it only moves to `section` (none: stays put).
 */
export function openSettings(
  section?: SettingsSection,
  state: NavState | undefined = currentNavState(),
) {
  if (focusedRoute(state)?.name === 'settings') {
    if (section) router.setParams({ section });
    return;
  }
  pushInShell(settingsHref(section), state);
}

/**
 * The Household page (`/household`): a page pushed on the current tab like Settings, so
 * back returns where the listener was (from "Who's listening?" or the full player it
 * lands in the shell underneath, `pushInShell`). On the page already, nothing happens.
 * Every way in goes through here: the profile menu, "Who's listening?" > Manage household,
 * Settings, Home's house row.
 *
 * Takes no argument, so it can be an `onPress` as it is: a press hands its event to the
 * handler, which a navigation-state parameter once read as the state and threw on.
 */
export function openHousehold() {
  const state = currentNavState();
  if (focusedRoute(state)?.name === 'household') return;
  pushInShell(householdHref(), state);
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
    /** A podcast show page (Bridge Phase 2d-1), by the show's folder path. */
    openPodcastShow: (connectionId: string, libraryId: number, show: string) =>
      go(podcastShowHref(connectionId, libraryId, show)),
    /** Find shows for a podcast library (Bridge Phase 2d-2), on `section` when given. */
    openFindShows: (connectionId: string, libraryId: number, section?: FindShowsSection) =>
      go(findShowsHref(connectionId, libraryId, section)),
    /** The Journal (across every server; the You hub's Journal), on `tab` when given. */
    openJournal: (tab?: JournalTab) => openJournal(tab),
    /** The You hub (the Me tab's root) on `section`. */
    openYou: (section?: CoreYouSection) => openYou(section),
    /** Settings, on `section` when given. */
    openSettings: (section?: SettingsSection) => openSettings(section),
  };
}
