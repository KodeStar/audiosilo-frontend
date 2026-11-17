import { renderRouter } from 'expo-router/testing-library';

import { nav, realRouteTree, routeInfo, router, tabStack } from '@/testing/route-tree';

// Its own file: the router store's segments leak between renders in one file, which
// would make a cold link look warm (see route-tree-cold.test.tsx).
it('opens a cold /you link as the Me tab root, keeping its section and tab', async () => {
  await (renderRouter(realRouteTree(), {
    initialUrl: '/you?section=journal&tab=bookmarks',
  }) as unknown as Promise<unknown>);
  expect(routeInfo().segments).toEqual(['(app)', '(me)', 'you']);
  expect(routeInfo().params).toEqual({ section: 'journal', tab: 'bookmarks' });
  // The tab's root, not a page pushed over it. (`canGoBack` can't say this: since
  // expo-router 58 the tab navigator's history keeps the first tab under a cold link.)
  expect(tabStack('(me)')).toEqual(['you']);
  // Back at that root goes Home, the first tab the history keeps underneath (intended,
  // CONVENTIONS "Cold deep link owner = Home"; fe#252 pins it).
  expect(router.canGoBack()).toBe(true);
  await nav(() => router.back());
  expect(routeInfo().segments.slice(0, 2)).toEqual(['(app)', '(home)']);
  expect(routeInfo().pathname).toBe('/');
});
