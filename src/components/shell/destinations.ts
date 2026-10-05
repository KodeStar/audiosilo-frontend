import { router, useNavigationContainerRef, useSegments, type Href } from 'expo-router';
import type { MaterialIcon, SFSymbolIcon } from 'expo-router/unstable-native-tabs';
import { useCallback } from 'react';

import type { IconName } from '@/components/ui/icon';

/**
 * The app's destinations, in ONE table every piece of chrome reads: the native tab bar
 * (iOS/Android phone), the web phone tab bar, and the tablet/desktop top bar.
 *
 * Each destination is a route GROUP under `src/app/(app)/` - `(home)`, `(library)`,
 * `(search)`, `(offline)`, `(me)` - holding that tab's root screen. The shared detail
 * routes (book, folder, account, favourites, browse) live once in the array group
 * `(home,library,search,offline,me)/`, which expands into every tab, so the tab that
 * pushes a detail page owns it (expo-router resolves a push against the current
 * segments). Groups are invisible in URLs: `/`, `/library`, `/search`, `/downloads`,
 * `/settings`, `/book/...` are unchanged.
 *
 * The Downloads group is `(offline)`, not `(downloads)`: a cold deep link
 * (`/book/1?...`, which every tab could own) is given to the alphabetically FIRST tab
 * group, and that must be `(home)`.
 */
export type TabName = '(home)' | '(library)' | '(search)' | '(offline)' | '(me)';

/** i18n keys (under `nav.*` / `settings.*`) the chrome uses, typed so `t()` checks them. */
type LabelKey = 'nav.home' | 'nav.library' | 'nav.search' | 'nav.downloads' | 'nav.me';
type TitleKey = 'nav.home' | 'nav.library' | 'nav.search' | 'nav.downloads' | 'settings.title';

export type Destination = {
  name: TabName;
  /** The tab root's URL. */
  root: Href;
  /** The tab root's route name inside the tab's Stack (the file path under the group). */
  rootRoute: string;
  /** Tab bar / top bar label. */
  labelKey: LabelKey;
  /** The tab root's page title (Me's root is the Settings screen, for now). */
  titleKey: TitleKey;
  /** Our vendored glyph (web chrome, top bar). */
  icon: IconName;
  /** SF Symbol for the iOS native tab bar. */
  sf: SFSymbolIcon['sf'];
  /** Material Symbol for the Android native tab bar. */
  md: MaterialIcon['md'];
};

export const TABS: readonly Destination[] = [
  {
    name: '(home)',
    root: '/',
    rootRoute: 'index',
    labelKey: 'nav.home',
    titleKey: 'nav.home',
    icon: 'home',
    sf: 'house',
    md: 'home',
  },
  {
    name: '(library)',
    root: '/library',
    rootRoute: 'library/index',
    labelKey: 'nav.library',
    titleKey: 'nav.library',
    icon: 'library',
    sf: 'books.vertical',
    md: 'library_books',
  },
  {
    name: '(search)',
    root: '/search',
    rootRoute: 'search',
    labelKey: 'nav.search',
    titleKey: 'nav.search',
    icon: 'search',
    sf: 'magnifyingglass',
    md: 'search',
  },
  {
    name: '(offline)',
    root: '/downloads',
    rootRoute: 'downloads',
    labelKey: 'nav.downloads',
    titleKey: 'nav.downloads',
    icon: 'download',
    sf: 'arrow.down.circle',
    md: 'download',
  },
  {
    name: '(me)',
    root: '/settings',
    rootRoute: 'settings',
    labelKey: 'nav.me',
    titleKey: 'settings.title',
    icon: 'user',
    sf: 'person.crop.circle',
    md: 'person',
  },
];

/** The destinations the tablet/desktop top bar lists. Search is the omnisearch field and
 * Me is the settings icon + profile button there, so neither is a labelled destination.
 * ("You" - stats, year, journal - joins in Phase 5.) */
export const TOP_BAR_TABS: readonly Destination[] = TABS.filter(
  (t) => t.name !== '(search)' && t.name !== '(me)',
);

export function destination(name: TabName): Destination {
  return TABS.find((t) => t.name === name) ?? TABS[0];
}

/** The tab a set of route segments sits in (`['(app)', '(library)', 'book', ...]`), or
 * null outside the tabs (connect, the player modal). */
export function tabOfSegments(segments: readonly string[]): TabName | null {
  if (segments[0] !== '(app)') return null;
  return TABS.find((t) => t.name === segments[1])?.name ?? null;
}

/** The tab root a Stack route name belongs to, or null for a detail route. */
export function rootOfRoute(routeName: string): Destination | null {
  return TABS.find((t) => t.rootRoute === routeName) ?? null;
}

/**
 * Each tab stack's root, so a cold deep link into a tab still has somewhere to go back
 * to. Keyed by group name - the array-group layout form, one `unstable_settings` for the
 * five stacks its single `_layout.tsx` expands into. Plain data so tests can import it.
 */
export const TAB_STACK_SETTINGS = {
  home: { initialRouteName: 'index' },
  library: { initialRouteName: 'library/index' },
  search: { initialRouteName: 'search' },
  offline: { initialRouteName: 'downloads' },
  me: { initialRouteName: 'settings' },
};

/** The active tab, from the router's current segments. */
export function useActiveTab(): TabName | null {
  // Typed as a literal tuple from the generated route types, which CI doesn't have.
  return tabOfSegments(useSegments() as string[]);
}

/**
 * Tab presses from OUR chrome (the web tab bar, the tablet/desktop top bar - all outside
 * the tab navigator). Another tab: dispatch JUMP_TO, which restores that tab's stack. A
 * href can't do it: `router.navigate('/(home)')` resolves to `/` and pops Home to its
 * root. The active tab again: navigate to its root, i.e. pop to top.
 */
export function useTabPress() {
  const ref = useNavigationContainerRef();
  const active = useActiveTab();
  const press = useCallback(
    (name: TabName) => {
      if (active === name) router.navigate(destination(name).root);
      else ref.dispatch({ type: 'JUMP_TO', payload: { name } });
    },
    [active, ref],
  );
  return { active, press };
}

/** The tab whose ROOT this pathname is (`/library`), or null for a pushed page. */
export function rootOfPathname(pathname: string): Destination | null {
  return TABS.find((t) => t.root === pathname) ?? null;
}

/** The slice of a React Navigation `navigation` object the param cleanup uses. */
type ParamsNavigation = {
  replaceParams: (params: object) => void;
  getParent: () => ParamsNavigation | undefined;
};

/**
 * Stack `screenListeners` for the tab stacks. A cold deep link (`/book/1?...`) builds its
 * tab's stack with the root inserted underneath, and React Navigation copies the link's
 * params onto that root AND every route above it (the tab, `(app)`, the root), which
 * expo-router merges into the URL - so backing out landed on `/?libraryId=1`. Tab roots
 * and their ancestors take no route params, so a tab root that comes into focus carrying
 * any has them replaced with none, up the chain.
 */
export function tabStackListeners({
  route,
  navigation,
}: {
  route: { name: string; params?: object };
  navigation: ParamsNavigation;
}) {
  return {
    focus: () => {
      if (!rootOfRoute(route.name) || !route.params || Object.keys(route.params).length === 0) {
        return;
      }
      for (let n: ParamsNavigation | undefined = navigation; n; n = n.getParent()) {
        n.replaceParams({});
      }
    },
  };
}
