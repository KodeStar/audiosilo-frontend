import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { noteProxyAnswer, resetProxyRefusalsForTests } from '@/api/proxy-refusal';
import type { User } from '@/api/types';
import { resetProfilesForTests } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { onAccountPage, ProxyRefusedBanner } from './proxy-refused-banner';

const mockPush = jest.fn();
jest.mock('@/lib/open', () => ({ pushInShell: (h: unknown) => mockPush(h) }));

const user: User = {
  id: 1,
  username: 'chris',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
};
const kid: User = { ...user, id: 12, username: 'evie', member_kind: 'kid' };
const AWAY = 'https://books.example.com';

async function signIn(who: User) {
  await useSession.getState().setSession({
    serverUrl: AWAY,
    serverId: 'srv-1',
    token: `tok-${who.id}`,
    user: who,
    name: 'Hearthside',
  });
}

beforeEach(async () => {
  resetProfilesForTests();
  resetProxyRefusalsForTests();
  mockPush.mockClear();
  await AsyncStorage.clear();
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    proxySets: {},
    signInProxySets: {},
  });
});

it('shows nothing while no proxy turns a connection away', async () => {
  await signIn(user);
  await render(<ProxyRefusedBanner />);
  expect(screen.queryByTestId('proxy-refused-banner')).toBeNull();
});

it("says the proxy turned the device away and opens the connection's Account, until a request gets through", async () => {
  await signIn(user);
  noteProxyAnswer('srv-1.1', true);
  await render(<ProxyRefusedBanner />);
  expect(
    screen.getByText(
      'The sign-in proxy for Hearthside turned this device away: update the proxy headers in Account',
    ),
  ).toBeTruthy();
  await fireEvent.press(screen.getByTestId('proxy-refused-banner'));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/account',
    params: { connection: 'srv-1.1' },
  });
  // It is not a sign-out: the connection stays as it was.
  expect(useSession.getState().connections.map((c) => [c.id, c.needsReconnect])).toEqual([
    ['srv-1.1', undefined],
  ]);
  await act(async () => noteProxyAnswer('srv-1.1', false));
  expect(screen.queryByTestId('proxy-refused-banner')).toBeNull();
});

// The banner stays up on the Account page while the headers are edited: a tap there must
// not stack the page again.
it("knows the connection's own Account page, which a tap does not push again", () => {
  const at = (name: string, params?: object) => ({
    routes: [{ name: '(app)', state: { routes: [{ name: 'index' }, { name, params }] } }],
  });
  expect(onAccountPage(at('account', { connection: 'srv-1.1' }), 'srv-1.1')).toBe(true);
  expect(onAccountPage(at('account', { connection: 'srv-2.1' }), 'srv-1.1')).toBe(false);
  expect(onAccountPage(at('account'), 'srv-1.1')).toBe(false);
  expect(onAccountPage(at('settings', { connection: 'srv-1.1' }), 'srv-1.1')).toBe(false);
  expect(onAccountPage(undefined, 'srv-1.1')).toBe(false);
});

it('leaves a connection that needs signing in again to the reconnect banner', async () => {
  await signIn(user);
  useSession.getState().markNeedsReconnect('srv-1.1', 'auth');
  noteProxyAnswer('srv-1.1', true);
  await render(<ProxyRefusedBanner />);
  expect(screen.queryByTestId('proxy-refused-banner')).toBeNull();
});

it("asks a kid to get a grown-up when the set is a full account's here too", async () => {
  await signIn(user);
  await signIn(kid);
  await act(async () => {
    await useSession.getState().setProxySet(AWAY, {
      origin: AWAY,
      headers: [{ name: 'X-Proxy', value: 'kept' }],
    });
  });
  noteProxyAnswer('srv-1.12', true);
  await render(<ProxyRefusedBanner />);
  expect(
    screen.getByText(
      'The sign-in proxy for Hearthside turned this device away: ask a grown-up to update the proxy headers',
    ),
  ).toBeTruthy();
  await fireEvent.press(screen.getByTestId('proxy-refused-banner'));
  expect(mockPush).not.toHaveBeenCalled();
});

// A demo account with no set to edit (`canManageProxySet`): nothing to tap, and no grown-up to
// ask either, so it only says what happened.
it('only says what happened to a demo account, with no grown-up to ask', async () => {
  await signIn({ ...user, id: 7, username: 'demo', is_demo: true });
  noteProxyAnswer('srv-1.7', true);
  await render(<ProxyRefusedBanner />);
  expect(screen.getByText('The sign-in proxy for Hearthside turned this device away')).toBeTruthy();
  expect(screen.queryByText(/grown-up/)).toBeNull();
  await fireEvent.press(screen.getByTestId('proxy-refused-banner'));
  expect(mockPush).not.toHaveBeenCalled();
});

// A kid's sign-in that got in on its own typed set where the kept one is stale (fe#295,
// `signInProxySets`): its requests get through, and a grown-up is asked to update the set.
it("asks a grown-up while a kid's sign-in is on its own set, until the address's set changes", async () => {
  const KEPT = { origin: AWAY, headers: [{ name: 'X-Proxy', value: 'kept' }] };
  const THEIRS = { origin: AWAY, headers: [{ name: 'X-Proxy', value: 'theirs' }] };
  await signIn(user);
  await signIn(kid);
  await act(async () => {
    await useSession.getState().setProxySet(AWAY, KEPT);
    useSession.setState({ signInProxySets: { 'srv-1.12': { set: THEIRS, over: KEPT } } });
  });
  await render(<ProxyRefusedBanner />);
  expect(screen.getByText('Ask a grown-up to update the proxy headers.')).toBeTruthy();
  await act(async () => {
    await useSession.getState().setProxySet(AWAY, {
      origin: AWAY,
      headers: [{ name: 'X-Proxy', value: 'fresh' }],
    });
  });
  expect(screen.queryByTestId('proxy-refused-banner')).toBeNull();
});
