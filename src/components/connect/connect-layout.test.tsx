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
  const router = {
    push: (h: unknown) => mockPush(h),
    dismissTo: (h: unknown) => mockDismissTo(h),
  };
  return {
    Stack,
    router,
    useRouter: () => router,
    useRootNavigationState: () => ({ key: 'root' }),
  };
});
// Whether this page load is a single sign-on's return (`/connect?oidc=1`, fe#310).
let mockReturning = false;
jest.mock('@/components/connect/oidc-sign-in', () => ({
  oidcReturnOnLoad: () => mockReturning,
}));
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  configurable: true,
});
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

/* eslint-disable import/first */
import ConnectLayout from '@/app/connect/_layout';
import { holdOidcIntent, takeOidcBook } from '@/components/connect/oidc-intent';
import {
  connectForNewProfile,
  endConnectFlow,
  kidsConnectAllowed,
  openAddSomeone,
  setConnectForNewProfile,
} from '@/components/profiles/connect-intent';
/* eslint-enable import/first */

beforeEach(() => {
  mockReturning = false;
  store.clear();
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

it('drops the proxy headers held for the flow when it is left (fe#167)', async () => {
  seedProfile();
  useSession.setState({
    pendingProxyHeaders: { origin: 'https://a.example', headers: [{ name: 'X-A', value: 'v' }] },
  });
  const view = await render(<ConnectLayout />);
  expect(useSession.getState().pendingProxyHeaders).not.toBeNull();
  await view.unmount();
  expect(useSession.getState().pendingProxyHeaders).toBeNull();
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

describe("a single sign-on's return (a page load, fe#310)", () => {
  // A grown-up's "Add someone" from kids mode leaves for the provider with a book: the page
  // load then forgets both, as it forgets everything in memory.
  const leaveForProvider = () => {
    seedProfile({ kids: true });
    openAddSomeone();
    setConnectForNewProfile(true);
    holdOidcIntent({ libraryId: 3, path: 'Austen/Emma' });
    endConnectFlow();
  };

  it("lets the grown-up's pass back through kids mode, for a new person, ending on the book", async () => {
    leaveForProvider();
    mockReturning = true;
    await render(<ConnectLayout />);
    expect(screen.getByText('connect flow')).toBeTruthy();
    expect(mockDismissTo).not.toHaveBeenCalled();
    expect(kidsConnectAllowed()).toBe(true);
    expect(connectForNewProfile()).toBe(true);
    expect(takeOidcBook()).toEqual({ libraryId: 3, path: 'Austen/Emma' });
  });

  it('puts it back only once the profiles are read', async () => {
    leaveForProvider();
    const kidsProfiles = useProfiles.getState();
    resetProfilesForTests();
    mockReturning = true;
    await render(<ConnectLayout />);
    expect(kidsConnectAllowed()).toBe(false);
    await act(async () => useProfiles.setState(kidsProfiles));
    expect(screen.getByText('connect flow')).toBeTruthy();
    expect(kidsConnectAllowed()).toBe(true);
  });

  it('gives no pass to a flow that is not the return: kids mode turns it away', async () => {
    leaveForProvider();
    await render(<ConnectLayout />);
    expect(screen.queryByText('connect flow')).toBeNull();
    expect(mockDismissTo).toHaveBeenCalledWith('/kids');
    // Taken all the same: a later return finds nothing.
    expect(store.size).toBe(0);
  });
});
