import { Stack } from 'expo-router';
import { store } from 'expo-router/build/global-state/router-store';
import { act, renderRouter } from 'expo-router/testing-library';

import { endKidsConnect, openAddSomeone } from '@/components/profiles/connect-intent';
import { toast } from '@/components/ui/toast';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { nav, realRouteTree, routeInfo, router } from '@/testing/route-tree';
import { seedProfile } from '@/testing/seed-profile';

import { KidsRouteGuard } from './kids-route-guard';

jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));

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

afterEach(() => {
  resetProfilesForTests();
  endKidsConnect();
  jest.mocked(toast).mockClear();
});

/** A kid-only device: one person, Leo, in kids mode (`seedProfile`), plus a grown-up when
 * `grownUp`. */
function household({ grownUp }: { grownUp: boolean }) {
  seedProfile({ kids: true });
  if (grownUp) {
    useProfiles.setState((s) => ({
      profiles: [...s.profiles, { id: 'g', name: 'Sam', connectionIds: ['srv.2'] }],
    }));
  }
}

it.each([
  ['Home', '/'],
  ['a cold book link', '/book/1?connection=c&path=x'],
  ['search', '/search'],
  ['settings', '/settings'],
  ['downloads', '/downloads'],
])('sends a kids profile from %s to /kids', async (_name, url) => {
  seedProfile({ kids: true });
  await mount(url);
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(rootRoutes()).toEqual(['kids']);
});

it('sends a kids profile from the full player (a widget link) back to /kids', async () => {
  seedProfile({ kids: true });
  await mount('/player?connection=c&libraryId=1&path=x');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(rootRoutes()).not.toContain('player');
});

it('pops the end credits off kids mode rather than stacking a second /kids', async () => {
  seedProfile({ kids: true });
  await mount('/kids');
  await nav(() => router.push('/finished'));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(rootRoutes().filter((r) => r === 'kids')).toHaveLength(1);
  expect(rootRoutes()).not.toContain('finished');
});

it('lets a kids profile open "Who\'s listening?"', async () => {
  seedProfile({ kids: true });
  await mount('/kids');
  await nav(() => router.push('/profiles'));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/profiles');
});

it('never lets a kids profile into the connect flow (D1): a link goes back to /kids, saying why', async () => {
  household({ grownUp: true });
  await mount('/kids');
  await nav(() => router.push('/connect?token=abc&server=https%3A%2F%2Fbooks.example'));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(rootRoutes()).not.toContain('connect');
  expect(toast).toHaveBeenCalledWith({
    title: 'Ask a grown-up to open this link',
    description: 'A grown-up holds Grown-ups first, then opens the link again.',
  });
});

it('sends a cold pairing link (audiosilo://connect, /web/connect?token=) in kids mode to /kids', async () => {
  household({ grownUp: false });
  await mount('/connect?token=abc');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(toast).toHaveBeenCalledTimes(1);
});

it("refuses the sign-in step too (the old reconnect banner's way in)", async () => {
  household({ grownUp: false });
  await mount('/kids');
  await nav(() => router.push('/connect/sign-in?reconnect=srv.1'));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
});

it('lets a grown-up\'s "Add someone" through on a device with no grown-up, until the flow is left', async () => {
  household({ grownUp: false });
  await mount('/kids');
  await nav(() => router.push('/profiles'));
  await nav(() => openAddSomeone());
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/connect');
  await nav(() => router.push('/connect/scan'));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/connect/scan');
  expect(toast).not.toHaveBeenCalled();

  // Left (back to kids mode): the pass is spent, so a link afterwards is refused.
  await nav(() => router.dismissTo('/kids'));
  await nav(() => {});
  await nav(() => router.push('/connect?token=abc'));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
});

it('gives no pass with a grown-up on the device ("Add someone" waits for them)', async () => {
  household({ grownUp: true });
  await mount('/kids');
  await nav(() => router.push('/profiles'));
  await nav(() => openAddSomeone());
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
});

it("takes a kid's first sign-in straight to /kids, with no toast (D9)", async () => {
  useProfiles.setState({ hydrated: true, profiles: [], activeProfileId: null });
  await mount('/connect/sign-in');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/connect/sign-in');
  // `finishConnect` placed the kid's account and turned kids mode on.
  await act(async () => seedProfile({ kids: true }));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
  expect(toast).not.toHaveBeenCalled();
});

it('moves a profile that becomes a kids profile while on Home', async () => {
  seedProfile();
  await mount('/');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/');
  await act(async () => seedProfile({ kids: true }));
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
});

it('leaves a grown-up profile where it is', async () => {
  seedProfile();
  await mount('/search');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/search');
  await nav(() => router.push('/player'));
  expect(routeInfo().pathname).toBe('/player');
});

it("sends a grown-up off kids mode's screen and takes it off the stack", async () => {
  seedProfile({ kids: true });
  await mount('/');
  await nav(() => {});
  expect(rootRoutes()).toEqual(['kids']);
  // A grown-up on kids mode's screen (it stays under the shell after leaving kids mode
  // through "Who's listening?", so back, a swipe or web history land there).
  await act(async () => seedProfile());
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/');
  expect(rootRoutes()).toEqual(['(app)']);
});

it('waits for the profiles before moving anyone off /kids', async () => {
  useProfiles.setState({ hydrated: false });
  await mount('/kids');
  await nav(() => {});
  expect(routeInfo().pathname).toBe('/kids');
});
