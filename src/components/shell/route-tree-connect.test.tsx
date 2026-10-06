import { renderRouter } from 'expo-router/testing-library';
import { store } from 'expo-router/build/global-state/router-store';

import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

import { LeaveOnboarding } from './leave-onboarding';

// Its own file: it starts cold on /connect (see route-tree-cold.test.tsx).
const rootRoutes = () => (store.state?.routes[0]?.state?.routes ?? []).map((r) => r.name);

it('leaves ONE (app) under the stack after connecting (dismissTo, not replace)', async () => {
  await (renderRouter(realRouteTree(), { initialUrl: '/connect' }) as unknown as Promise<unknown>);
  // The root's anchor keeps (app) under onboarding.
  expect(rootRoutes()).toEqual(['(app)', 'connect']);
  await nav(() => router.dismissTo('/'));
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().pathname).toBe('/');
});

it('leaves ONE (app) when a screen exits onboarding at render time (LeaveOnboarding)', async () => {
  const tree = realRouteTree();
  // A <Redirect href="/"> here (a replace) left ['(app)', '(app)'].
  tree['connect/index'] = () => <LeaveOnboarding />;
  await (renderRouter(tree, { initialUrl: '/connect' }) as unknown as Promise<unknown>);
  await nav(() => {});
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().pathname).toBe('/');
});
