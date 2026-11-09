import { renderRouter } from 'expo-router/testing-library';

import {
  nav,
  realRouteTree,
  rootRoutes,
  routeInfo,
  router,
  stackRoutes,
} from '@/testing/route-tree';

// Its own file: each test starts cold (see route-tree-cold.test.tsx).
const connectRoutes = () => stackRoutes('connect');

const mount = (url: string) =>
  renderRouter(realRouteTree(), { initialUrl: url }) as unknown as Promise<unknown>;

it('the first sign-in replaces itself with the ready screen, inside onboarding', async () => {
  await mount('/connect');
  await nav(() => router.push('/connect/sign-in'));
  await nav(() => router.replace({ pathname: '/connect/ready', params: { connection: 'c' } }));
  expect(rootRoutes()).toEqual(['(app)', 'connect']);
  expect(connectRoutes()).toEqual(['index', 'ready']);
  expect(routeInfo().params).toMatchObject({ connection: 'c' });
});

it('"Browse the library" leaves ONE (app) under the stack, on the Library', async () => {
  await mount('/connect');
  await nav(() => router.replace({ pathname: '/connect/ready', params: { connection: 'c' } }));
  await nav(() => router.dismissTo('/library'));
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().pathname).toBe('/library');
});

it('"Another server" from a reconnect sign-in opened over the app lands on the first step', async () => {
  await mount('/');
  await nav(() => router.push('/connect/sign-in'));
  await nav(() => router.dismissTo('/connect'));
  expect(rootRoutes()).toEqual(['(app)', 'connect']);
  expect(connectRoutes()).toEqual(['index']);
  expect(routeInfo().pathname).toBe('/connect');
});
