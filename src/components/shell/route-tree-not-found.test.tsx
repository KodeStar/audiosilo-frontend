import { store } from 'expo-router/build/global-state/router-store';
import { renderRouter } from 'expo-router/testing-library';

import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

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

it("goes Home onto the anchored shell under it, never a second one (its Home button's `dismissTo`)", async () => {
  await mount('/nope');
  const rootRoutes = () =>
    (store.navigationRef.getRootState().routes[0].state?.routes ?? []).map((r) => r.name);
  expect(rootRoutes()).toEqual(['(app)', '+not-found']);
  await nav(() => router.dismissTo('/'));
  expect(rootRoutes()).toEqual(['(app)']);
});
