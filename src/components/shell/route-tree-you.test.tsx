import { store } from 'expo-router/build/global-state/router-store';
import { renderRouter } from 'expo-router/testing-library';

import { openJournal, openSettings, openYou } from '@/lib/open';
import { playerHref } from '@/lib/paths';
import { popTabToRoot } from '@/lib/root-stack';
import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// The You hub is the Me tab's ROOT: every way in (the palette, the profile menu, a book
// section's journal link, from over the full player) lands on that root with the asked
// section, never a second copy of it pushed on the Me stack or on another tab. Settings is
// a page pushed on the current tab.

const mount = (initialUrl: string) =>
  renderRouter(realRouteTree(), { initialUrl }) as unknown as Promise<unknown>;

type Route = { name: string; params?: object; state?: { routes: Route[] } };
const shell = () =>
  ((store.state?.routes[0] as Route | undefined)?.state?.routes ?? []).find(
    (r) => r.name === '(app)',
  );
/** The routes of the shell's `tab` stack. */
const tabStack = (tab: string) =>
  (shell()?.state?.routes.find((r) => r.name === tab)?.state?.routes ?? []).map((r) => r.name);
const rootRoutes = () =>
  ((store.state?.routes[0] as Route | undefined)?.state?.routes ?? []).map((r) => r.name);

it('opens the hub from another tab on its root, keeping that tab as it was', async () => {
  await mount('/library');
  await nav(() => router.push('/book/1?connection=c&path=x'));
  await nav(() => openJournal('notes'));
  expect(routeInfo().segments).toEqual(['(app)', '(me)', 'you']);
  expect(routeInfo().params).toEqual({ section: 'journal', tab: 'notes' });
  expect(tabStack('(me)')).toEqual(['you']);
  expect(tabStack('(library)')).toEqual(['library/index', 'book/[libraryId]']);
});

it('moves the hub to a section in place, and pops pages pushed over it', async () => {
  await mount('/you');
  await nav(() => openYou('year'));
  expect(routeInfo().params).toEqual({ section: 'year' });
  expect(tabStack('(me)')).toEqual(['you']);

  await nav(() => router.push('/account?connection=c'));
  await nav(() => openJournal());
  expect(routeInfo().pathname).toBe('/you');
  expect(routeInfo().params).toEqual({ section: 'journal' });
  expect(tabStack('(me)')).toEqual(['you']);
  expect(router.canGoBack()).toBe(false);
});

it("pops the Me tab's pages when opened from another tab too", async () => {
  await mount('/you');
  await nav(() => router.push('/account?connection=c'));
  const { store: s } = jest.requireActual('expo-router/build/global-state/router-store');
  await nav(() => s.navigationRef.dispatch({ type: 'JUMP_TO', payload: { name: '(home)' } }));
  await nav(() => openYou('stats'));
  expect(routeInfo().pathnameWithParams).toBe('/you');
  expect(tabStack('(me)')).toEqual(['you']);
});

it("pops the hub's stack to the root on a second press of its tab, keeping the section", async () => {
  // What `useTabPress` does for the active tab (a navigate to the root's href pushed a
  // second hub over the pages).
  await mount('/you?section=year');
  await nav(() => router.push('/account?connection=c'));
  await nav(() => popTabToRoot('(me)'));
  // On the root already: nothing to pop.
  await nav(() => popTabToRoot('(me)'));
  expect(tabStack('(me)')).toEqual(['you']);
  expect(routeInfo().params).toEqual({ section: 'year' });
});

it('opens the hub from over the full player in the one shell underneath', async () => {
  await mount('/library');
  await nav(() => router.push(playerHref('c', 1, 'x')));
  // A book section's "See all in your journal".
  await nav(() => openJournal('bookmarks'));
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().segments).toEqual(['(app)', '(me)', 'you']);
  expect(routeInfo().params).toEqual({ section: 'journal', tab: 'bookmarks' });
});

it('pushes Settings on the current tab, and only moves the pane when already there', async () => {
  await mount('/library');
  await nav(() => openSettings());
  expect(routeInfo().segments).toEqual(['(app)', '(library)', 'settings']);
  await nav(() => openSettings('accounts'));
  expect(tabStack('(library)')).toEqual(['library/index', 'settings']);
  expect(routeInfo().params).toEqual({ section: 'accounts' });
  // The gear again: stays put.
  await nav(() => openSettings());
  expect(tabStack('(library)')).toEqual(['library/index', 'settings']);
  await nav(() => router.back());
  expect(routeInfo().pathname).toBe('/library');
});

it('opens Settings from over the full player in the shell underneath', async () => {
  await mount('/search');
  await nav(() => router.push(playerHref('c', 1, 'x')));
  await nav(() => openSettings('sleep'));
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().segments).toEqual(['(app)', '(search)', 'settings']);
  expect(routeInfo().params).toEqual({ section: 'sleep' });
});
