import { render, screen } from '@testing-library/react-native';

import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';
import { seedProfile } from '@/testing/seed-profile';

// The flow's screens, as the layout's Stack: whatever renders here would run (a pairing
// link's token exchange starts as `/connect` mounts).
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const Stack = function Stack() {
    const { Text } = jest.requireActual('react-native');
    return <Text>connect flow</Text>;
  };
  Stack.Screen = function Screen() {
    return null;
  };
  return { Stack, router: { push: (h: unknown) => mockPush(h) } };
});

/* eslint-disable import/first */
import ConnectLayout from '@/app/connect/_layout';
import {
  connectForNewProfile,
  endKidsConnect,
  kidsConnectAllowed,
  openAddSomeone,
  setConnectForNewProfile,
} from '@/components/profiles/connect-intent';
/* eslint-enable import/first */

beforeEach(() => {
  useSession.setState({ status: 'authenticated' });
  mockPush.mockClear();
});
afterEach(() => {
  resetProfilesForTests();
  endKidsConnect();
  setConnectForNewProfile(false);
});

it('runs the flow for a grown-up', async () => {
  seedProfile();
  await render(<ConnectLayout />);
  expect(screen.getByText('connect flow')).toBeTruthy();
});

it("runs none of the flow while a kids profile listens (D1: a link's token stays unspent)", async () => {
  seedProfile({ kids: true });
  await render(<ConnectLayout />);
  expect(screen.queryByText('connect flow')).toBeNull();
});

it('runs it for a grown-up\'s "Add someone" from kids mode on a device with no grown-up', async () => {
  seedProfile({ kids: true });
  openAddSomeone();
  expect(mockPush).toHaveBeenCalledWith('/connect?add=1&profile=new');
  expect(kidsConnectAllowed()).toBe(true);
  const view = await render(<ConnectLayout />);
  expect(screen.getByText('connect flow')).toBeTruthy();
  // Leaving the flow ends the pass (and the new-person intent with it).
  setConnectForNewProfile(true);
  await view.unmount();
  expect(kidsConnectAllowed()).toBe(false);
  expect(connectForNewProfile()).toBe(false);
});

it('gives no pass with a grown-up on the device, nor for a grown-up', async () => {
  seedProfile({ kids: true });
  useProfiles.setState((s) => ({
    profiles: [...s.profiles, { id: 'g', name: 'Sam', connectionIds: ['srv.2'] }],
  }));
  openAddSomeone();
  expect(kidsConnectAllowed()).toBe(false);
  seedProfile();
  openAddSomeone();
  expect(kidsConnectAllowed()).toBe(false);
  expect(mockPush).toHaveBeenCalledTimes(2);
});
