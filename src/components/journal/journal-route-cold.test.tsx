import { renderRouter } from 'expo-router/testing-library';

import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// Its own file: the router store's segments leak between renders in one file, which
// would make a cold link look warm (see route-tree-cold.test.tsx).
it('opens a cold /journal?tab= link in Home, with Home underneath to go back to', async () => {
  await (renderRouter(realRouteTree(), {
    initialUrl: '/journal?tab=bookmarks',
  }) as unknown as Promise<unknown>);
  expect(routeInfo().segments.slice(0, 2)).toEqual(['(app)', '(home)']);
  expect(routeInfo().pathname).toBe('/journal');
  expect(routeInfo().params).toMatchObject({ tab: 'bookmarks' });
  expect(router.canGoBack()).toBe(true);
  await nav(() => router.back());
  expect(routeInfo().pathnameWithParams).toBe('/');
});
