import { Stack } from 'expo-router';
import { store } from 'expo-router/build/global-state/router-store';
import { act, renderRouter } from 'expo-router/testing-library';

import { useProfiles } from '@/stores/profiles';
import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

import { KidsRouteGuard } from './kids-route-guard';

// The real route tree with the guard mounted by the root layout, as `src/app/_layout.tsx`
// mounts it (the root keeps its real `anchor`).
const rootRoutes = () => (store.state?.routes[0]?.state?.routes ?? []).map((r) => r.name);

function mount(initialUrl: string) {
  const tree = realRouteTree();
  tree._layout = {
    default: () => (
      <>
        <Stack screenOptions={{ headerShown: false }} />
        <KidsRouteGuard />
      </>
    ),
    unstable_settings: { anchor: '(app)' },
  } as unknown as (typeof tree)['_layout'];
  return renderRouter(tree, { initialUrl }) as unknown as Promise<unknown>;
}

const setProfile = (kids: boolean) =>
  useProfiles.setState({
    profiles: [
      {
        id: 'p',
        name: 'Leo',
        connectionIds: ['srv.1'],
        ...(kids ? { kids: { bedtime: '19:30' } } : {}),
      },
    ],
    activeProfileId: 'p',
    hydrated: true,
  });

afterEach(() => {
  useProfiles.setState({ profiles: [], activeProfileId: null, hydrated: false });
});

it.each([
  ['Home', '/'],
  ['a cold book link', '/book/1?connection=c&path=x'],
  ['search', '/search'],
  ['settings', '/settings'],
  ['downloads', '/downloads'],
])('sends a kids profile from %s to /kids', async (_name, url) => {
  setProfile(true);
  await mount(url);
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(rootRoutes()).toEqual(['kids']);
});

it('sends a kids profile from the full player (a widget link) back to /kids', async () => {
  setProfile(true);
  await mount('/player?connection=c&libraryId=1&path=x');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(rootRoutes()).not.toContain('player');
});

it('pops the end credits off kids mode rather than stacking a second /kids', async () => {
  setProfile(true);
  await mount('/kids');
  await nav(() => router.push('/finished'));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(rootRoutes().filter((r) => r === 'kids')).toHaveLength(1);
  expect(rootRoutes()).not.toContain('finished');
});

it('lets a kids profile open "Who\'s listening?" and the connect flow', async () => {
  setProfile(true);
  await mount('/kids');
  await nav(() => router.push('/connect'));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/connect');
});

it('moves a profile that becomes a kids profile while on Home', async () => {
  setProfile(false);
  await mount('/');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/');
  await act(async () => setProfile(true));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
});

it('leaves a grown-up profile where it is', async () => {
  setProfile(false);
  await mount('/search');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/search');
  await nav(() => router.push('/player'));
  expect(routeInfo().pathname).toBe('/player');
});
