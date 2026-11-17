import { renderRouter } from 'expo-router/testing-library';

import { endConnect } from '@/components/connect/finish-connect';
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

// fe#299: a scan from the first sign-in step replaced the scanner with a `/connect` of its
// own over that step; "Your library is ready." keeps only the first step under it, so Back
// never returns to the spent sign-in step.
it.each([
  ['a sign-in', ['/connect/sign-in']],
  [
    "a scan from the sign-in step (the scanner replaced by the code's /connect)",
    ['/connect/sign-in', '/connect/scan'],
  ],
])('ends the first run over the first step only, after %s', async (_, steps) => {
  await mount('/connect');
  for (const step of steps) await nav(() => router.push(step));
  if (steps.length > 1) {
    await nav(() => router.replace({ pathname: '/connect', params: { token: 't' } }));
  }
  await nav(() => endConnect('c', undefined, true));
  expect(connectRoutes()).toEqual(['index', 'ready']);
  expect(routeInfo().params).toMatchObject({ connection: 'c' });
});

it('ends a first run a link opened on the sign-in step on the ready screen alone', async () => {
  await mount('/connect/sign-in');
  await nav(() => endConnect('c', undefined, true));
  expect(connectRoutes()).toEqual(['ready']);
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
