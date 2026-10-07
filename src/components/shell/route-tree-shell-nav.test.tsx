import { store } from 'expo-router/build/global-state/router-store';
import { renderRouter } from 'expo-router/testing-library';

import { pushInShell } from '@/lib/open';
import { bookHref, finishedHref, playerHref } from '@/lib/paths';
import { currentNavState, topRootRoute } from '@/lib/root-stack';
import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// A page opened from over the full player or the credits (Up next's sheet over the player,
// its overflow menu's "View book details") lands in the ONE app shell underneath, in the
// tab the listener was on; a push or a replace from there stacked a second `(app)`.

const mount = (initialUrl: string) =>
  renderRouter(realRouteTree(), { initialUrl }) as unknown as Promise<unknown>;

type Route = { name: string; state?: { index?: number; routes: Route[] } };
/** The root stack's routes (under expo-router's `__root`). */
const rootRoutes = () =>
  ((store.state?.routes[0] as Route | undefined)?.state?.routes ?? []).map((r) => r.name);
/** The routes of the shell's `tab` stack. */
const tabStack = (tab: string) => {
  const shell = (store.state?.routes[0] as Route).state!.routes[0];
  const stack = shell.state?.routes.find((r) => r.name === tab);
  return (stack?.state?.routes ?? []).map((r) => r.name);
};

const BOOK = bookHref('c', 1, 'a/b');

it('opens a page from over the full player in the shell underneath, in its tab', async () => {
  await mount('/library');
  await nav(() => router.push(playerHref('c', 1, 'x')));
  expect(topRootRoute(currentNavState())).toBe('player');
  await nav(() => pushInShell(BOOK));
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().segments.slice(0, 2)).toEqual(['(app)', '(library)']);
  expect(tabStack('(library)')).toEqual(['library/index', 'book/[libraryId]']);
  expect(routeInfo().params).toMatchObject({ connection: 'c', path: 'a/b', libraryId: '1' });
  // Back returns to the page the player was opened over.
  await nav(() => router.back());
  expect(routeInfo().pathname).toBe('/library');
});

it('opens a page from over the credits the same way', async () => {
  await mount('/search');
  await nav(() => router.push(finishedHref('c', 1, 'x')));
  expect(topRootRoute(currentNavState())).toBe('finished');
  await nav(() => pushInShell(BOOK));
  expect(rootRoutes()).toEqual(['(app)']);
  expect(tabStack('(search)')).toEqual(['search', 'book/[libraryId]']);
});

it('is a plain push into the current tab from a shell page', async () => {
  await mount('/library');
  expect(topRootRoute(currentNavState())).toBe('(app)');
  await nav(() => pushInShell(BOOK));
  expect(rootRoutes()).toEqual(['(app)']);
  expect(tabStack('(library)')).toEqual(['library/index', 'book/[libraryId]']);
});
