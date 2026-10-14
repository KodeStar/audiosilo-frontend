import { renderRouter } from 'expo-router/testing-library';

import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// Its own file: the router store's segments leak between renders in one file, which
// would make a cold link look warm (see route-tree-cold.test.tsx).
it('opens a cold /household link in Home, with Home underneath to go back to', async () => {
  await (renderRouter(realRouteTree(), {
    initialUrl: '/household',
  }) as unknown as Promise<unknown>);
  expect(routeInfo().segments).toEqual(['(app)', '(home)', 'household']);
  expect(router.canGoBack()).toBe(true);
  await nav(() => router.back());
  expect(routeInfo().pathnameWithParams).toBe('/');
});
