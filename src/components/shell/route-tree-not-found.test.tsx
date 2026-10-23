import { renderRouter } from 'expo-router/testing-library';

import { realRouteTree, routeInfo } from '@/testing/route-tree';

// An address the app has no page for (a mistyped or old `/web/...` link) lands on the
// app's own `+not-found` page, never Expo Router's "Unmatched Route" (CONNECT-02).

const mount = (initialUrl: string) =>
  renderRouter(realRouteTree(), { initialUrl }) as unknown as Promise<unknown>;

it.each(['/nope', '/connect/nope', '/book/nope/deeper'])(
  'opens %s on the not-found page',
  async (url) => {
    await mount(url);
    expect(routeInfo().segments).toEqual(['+not-found']);
  },
);

it('still opens a real page', async () => {
  await mount('/library');
  expect(routeInfo().segments).not.toContain('+not-found');
});
