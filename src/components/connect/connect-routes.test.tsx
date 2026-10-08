import { act, render, screen } from '@testing-library/react-native';

import type { User } from '@/api/types';
import { useSession } from '@/stores/session';

let mockParams: Record<string, string> = {};
// The last focus effect: calling it again is the screen coming back on top.
let mockRefocus: (() => void) | null = null;
const mockLeave = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => {
    const { useEffect } = jest.requireActual('react');
    useEffect(() => {
      mockRefocus = cb;
      cb();
    }, [cb]);
  },
  Redirect: ({ href }: { href: string }) => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>{`redirect ${href}`}</T>;
  },
}));
jest.mock('@/components/shell/leave-onboarding', () => ({
  leaveOnboarding: () => mockLeave(),
  LeaveOnboarding: () => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>left onboarding</T>;
  },
}));
jest.mock('@/components/connect/connect-start', () => ({
  ConnectStart: () => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>first step</T>;
  },
}));
jest.mock('@/components/connect/sign-in-step', () => ({
  SignInStep: ({ server, reconnectId }: { server: string; reconnectId?: string }) => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>{`sign in ${server} ${reconnectId ?? ''}`}</T>;
  },
}));
jest.mock('@/components/connect/ready-screen', () => ({
  ReadyScreen: ({ name }: { name: string }) => {
    const { Text: T } = jest.requireActual('react-native');
    return <T>{`ready ${name}`}</T>;
  },
}));
jest.mock('@/api/provider', () => ({
  ConnectionScope: ({ children }: { children: unknown }) => children,
}));

/* eslint-disable import/first */
import ConnectRoute from '@/app/connect/index';
import ReadyRoute from '@/app/connect/ready';
import SignInRoute from '@/app/connect/sign-in';
/* eslint-enable import/first */

const user = { id: 1, username: 'u', role: 'user' } as User;
const signedIn = (pending: string | null = null) =>
  useSession.setState({
    status: 'authenticated',
    connections: [{ id: 'c1', serverUrl: 'https://a', name: 'Hearthside', token: 't', user }],
    defaultConnectionId: 'c1',
    pendingServerUrl: pending,
    user,
  });
const signedOut = (pending: string | null = null) =>
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: pending,
    user: null,
  });

beforeEach(() => {
  mockParams = {};
  mockLeave.mockClear();
});

describe('/connect', () => {
  it('bounces a signed-in listener with nothing to add', async () => {
    signedIn();
    await render(<ConnectRoute />);
    expect(screen.getByText('left onboarding')).toBeTruthy();
  });

  it('stays for ?add=1, a pairing token, or a sign-in mid-flow', async () => {
    signedIn();
    mockParams = { add: '1' };
    await render(<ConnectRoute />);
    expect(screen.getByText('first step')).toBeTruthy();
    mockParams = { token: 't' };
    await render(<ConnectRoute />);
    expect(screen.getByText('first step')).toBeTruthy();
    mockParams = {};
    await act(async () => signedIn('https://b'));
    await render(<ConnectRoute />);
    expect(screen.getByText('first step')).toBeTruthy();
  });

  it('does not bounce when a sign-in finishes on top of it (the flow goes on to "ready")', async () => {
    signedOut('https://a');
    await render(<ConnectRoute />);
    await act(async () => signedIn(null));
    expect(screen.getByText('first step')).toBeTruthy();
    expect(mockLeave).not.toHaveBeenCalled();
  });

  it('back on top while signed in with nothing to add (back from "ready"): leaves', async () => {
    signedOut('https://a');
    await render(<ConnectRoute />);
    expect(mockLeave).not.toHaveBeenCalled();
    await act(async () => signedIn(null));
    await act(async () => mockRefocus?.());
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  it('back on top mid-way through adding a server: stays', async () => {
    signedIn('https://b');
    await render(<ConnectRoute />);
    await act(async () => mockRefocus?.());
    expect(mockLeave).not.toHaveBeenCalled();
  });
});

describe('/connect/sign-in', () => {
  it('reads the pending address once: signing in clears it without a bounce', async () => {
    signedOut('https://a');
    mockParams = { reconnect: 'c1' };
    await render(<SignInRoute />);
    expect(screen.getByText('sign in https://a c1')).toBeTruthy();
    await act(async () => signedIn(null));
    expect(screen.getByText('sign in https://a c1')).toBeTruthy();
  });

  it('goes back to the first step with no server to sign in to', async () => {
    signedOut(null);
    await render(<SignInRoute />);
    expect(screen.getByText('redirect /connect')).toBeTruthy();
  });
});

describe('/connect/ready', () => {
  it('shows the ready screen for the connection', async () => {
    signedIn();
    mockParams = { connection: 'c1' };
    await render(<ReadyRoute />);
    expect(screen.getByText('ready Hearthside')).toBeTruthy();
  });

  it('goes to the app for an unknown connection', async () => {
    signedIn();
    mockParams = { connection: 'gone' };
    await render(<ReadyRoute />);
    expect(screen.getByText('left onboarding')).toBeTruthy();
  });
});
