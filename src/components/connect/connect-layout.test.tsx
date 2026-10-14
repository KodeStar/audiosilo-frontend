import { act, render, screen } from '@testing-library/react-native';

import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';
import { seedProfile } from '@/testing/seed-profile';

// The flow's screens, as the layout's Stack: whatever renders here would run (a pairing
// link's token exchange starts as `/connect` mounts).
const mockPush = jest.fn();
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => {
  const Stack = function Stack() {
    const { Text } = jest.requireActual('react-native');
    return <Text>connect flow</Text>;
  };
  Stack.Screen = function Screen() {
    return null;
  };
  return {
    Stack,
    router: { push: (h: unknown) => mockPush(h), dismissTo: (h: unknown) => mockDismissTo(h) },
    useRootNavigationState: () => ({ key: 'root' }),
  };
});
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

/* eslint-disable import/first */
import ConnectLayout from '@/app/connect/_layout';
import {
  connectForNewProfile,
  endConnectFlow,
  kidsConnectAllowed,
  openAddSomeone,
  setConnectForNewProfile,
} from '@/components/profiles/connect-intent';
/* eslint-enable import/first */

beforeEach(() => {
  useSession.setState({ status: 'authenticated' });
  mockPush.mockClear();
  mockDismissTo.mockClear();
  mockToast.mockClear();
});
afterEach(() => {
  resetProfilesForTests();
  endConnectFlow();
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
  // A link reached in kids mode: back to /kids, asking a grown-up to open it.
  expect(mockDismissTo).toHaveBeenCalledWith('/kids');
  expect(mockToast).toHaveBeenCalledWith({
    title: 'Ask a grown-up to open this link',
    description: 'A grown-up holds Grown-ups first, then opens the link again.',
  });
});

it('runs nothing of the flow before the profiles are read (a cold start through a link)', async () => {
  // The session is read; the profiles are not yet (or their read is failing).
  await render(<ConnectLayout />);
  expect(screen.queryByText('connect flow')).toBeNull();
  expect(mockDismissTo).not.toHaveBeenCalled();
  // Read: kids mode was on, so the link opened in it, and a grown-up is asked to open it.
  await act(async () => seedProfile({ kids: true }));
  expect(screen.queryByText('connect flow')).toBeNull();
  expect(mockDismissTo).toHaveBeenCalledWith('/kids');
  expect(mockToast).toHaveBeenCalledWith({
    title: 'Ask a grown-up to open this link',
    description: 'A grown-up holds Grown-ups first, then opens the link again.',
  });
});

it('runs the flow for a grown-up once the profiles are read', async () => {
  await render(<ConnectLayout />);
  expect(screen.queryByText('connect flow')).toBeNull();
  await act(async () => seedProfile());
  expect(screen.getByText('connect flow')).toBeTruthy();
});

it("takes kids mode turned on mid-flow (a kid's first sign-in) to /kids, saying nothing", async () => {
  seedProfile();
  await render(<ConnectLayout />);
  expect(screen.getByText('connect flow')).toBeTruthy();
  await act(async () => seedProfile({ kids: true }));
  expect(screen.queryByText('connect flow')).toBeNull();
  expect(mockDismissTo).toHaveBeenCalledWith('/kids');
  expect(mockToast).not.toHaveBeenCalled();
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
