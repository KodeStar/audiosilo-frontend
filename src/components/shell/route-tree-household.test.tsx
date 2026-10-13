import { store } from 'expo-router/build/global-state/router-store';
import { renderRouter } from 'expo-router/testing-library';

import { openHousehold } from '@/components/household/open-household';
import { playerHref } from '@/lib/paths';
import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';

// The Household page (Phase 8b-1) is a page of the array group like Settings: pushed on the
// current tab, and the old `/settings?section=household` link REPLACES itself with it (the
// real settings route, its content stubbed), so back never bounces into the redirect.

jest.mock('@/components/settings/settings-content', () => {
  const { Text } = jest.requireActual('react-native');
  return { SettingsContent: () => <Text>settings-content</Text> };
});
jest.mock('@/lib/use-page-title', () => ({ usePageTitle: () => undefined }));

const SETTINGS = '(app)/(home,library,search,offline,me)/settings';

const mount = (initialUrl: string) => {
  const tree = realRouteTree();
  tree[SETTINGS] = jest.requireActual(`@/app/${SETTINGS}`);
  return renderRouter(tree, { initialUrl }) as unknown as Promise<unknown>;
};

type Route = { name: string; state?: { routes: Route[] } };
const shell = () =>
  ((store.state?.routes[0] as Route | undefined)?.state?.routes ?? []).find(
    (r) => r.name === '(app)',
  );
const tabStack = (tab: string) =>
  (shell()?.state?.routes.find((r) => r.name === tab)?.state?.routes ?? []).map((r) => r.name);
const rootRoutes = () =>
  ((store.state?.routes[0] as Route | undefined)?.state?.routes ?? []).map((r) => r.name);

it('pushes the Household page on the current tab, and stays put when already there', async () => {
  await mount('/library');
  await nav(() => openHousehold());
  expect(routeInfo().segments).toEqual(['(app)', '(library)', 'household']);
  await nav(() => openHousehold());
  expect(tabStack('(library)')).toEqual(['library/index', 'household']);
  await nav(() => router.back());
  expect(routeInfo().pathname).toBe('/library');
});

it('opens it from over the full player in the shell underneath', async () => {
  await mount('/search');
  await nav(() => router.push(playerHref('c', 1, 'x')));
  await nav(() => openHousehold());
  expect(rootRoutes()).toEqual(['(app)']);
  expect(routeInfo().segments).toEqual(['(app)', '(search)', 'household']);
});

it('replaces an old /settings?section=household link with the page (back skips it)', async () => {
  await mount('/library');
  await nav(() => router.push('/settings?section=household'));
  expect(routeInfo().pathname).toBe('/household');
  expect(tabStack('(library)')).toEqual(['library/index', 'household']);
  await nav(() => router.back());
  expect(routeInfo().pathname).toBe('/library');
});

it('keeps every other Settings link on Settings', async () => {
  await mount('/library');
  await nav(() => router.push('/settings?section=sleep'));
  expect(routeInfo().pathname).toBe('/settings');
  expect(routeInfo().params).toEqual({ section: 'sleep' });
});
