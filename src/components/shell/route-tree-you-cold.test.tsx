import { renderRouter } from 'expo-router/testing-library';

import { realRouteTree, routeInfo, router } from '@/testing/route-tree';

// Its own file: the router store's segments leak between renders in one file, which
// would make a cold link look warm (see route-tree-cold.test.tsx).
it('opens a cold /you link as the Me tab root, keeping its section and tab', async () => {
  await (renderRouter(realRouteTree(), {
    initialUrl: '/you?section=journal&tab=bookmarks',
  }) as unknown as Promise<unknown>);
  expect(routeInfo().segments).toEqual(['(app)', '(me)', 'you']);
  expect(routeInfo().params).toEqual({ section: 'journal', tab: 'bookmarks' });
  expect(router.canGoBack()).toBe(false);
});
