import { renderRouter } from 'expo-router/testing-library';

import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// Cold deep links live in their own file: the router store's previous segments leak
// between renders in one file, which would make a cold link look warm.
const mount = (initialUrl: string) =>
  renderRouter(realRouteTree(), { initialUrl }) as unknown as Promise<unknown>;

it('gives a cold book link to Home, with Home underneath to go back to', async () => {
  await mount('/book/1?connection=c&path=x');
  expect(routeInfo().segments.slice(0, 2)).toEqual(['(app)', '(home)']);
  expect(routeInfo().params).toMatchObject({ connection: 'c', path: 'x', libraryId: '1' });
  expect(router.canGoBack()).toBe(true);
  await nav(() => router.back());
  // Not `/?libraryId=1`: the link's params don't follow the reader back to the root.
  expect(routeInfo().pathnameWithParams).toBe('/');
  expect(routeInfo().params).toEqual({});
});
