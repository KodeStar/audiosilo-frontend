import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

const mockPush = jest.fn();
let mockFocused = true;
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  Redirect: () => null,
  useIsFocused: () => mockFocused,
}));
jest.mock('@/api/provider', () => ({ useOptionalApi: () => null }));
let mockTop: string | null = '(app)';
jest.mock('@/lib/root-stack', () => ({
  currentNavState: () => undefined,
  topRootRoute: () => mockTop,
  popTabToRoot: jest.fn(),
}));

/* eslint-disable import/first */
import { resetLaunchDecisionForTests } from '@/components/profiles/profiles-model';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { AuthGate } from './auth-gate';
/* eslint-enable import/first */

const two = [
  { id: 'chris', name: 'Chris', connectionIds: ['a.1'] },
  { id: 'sam', name: 'Sam', connectionIds: ['a.2'] },
];

beforeEach(() => {
  mockPush.mockClear();
  mockTop = '(app)';
  mockFocused = true;
  resetProfilesForTests();
  resetLaunchDecisionForTests();
  useSession.setState({
    status: 'authenticated',
    user: { username: 'chris', has_password: true, has_recovery: false } as never,
  });
});

const mount = () =>
  render(
    <AuthGate>
      <Text>shell</Text>
    </AuthGate>,
  );

describe('AuthGate and profiles (Phase 8)', () => {
  it('holds the shell until the profiles have loaded', async () => {
    await mount();
    expect(screen.queryByText('shell')).toBeNull();
    await act(async () => useProfiles.setState({ hydrated: true }));
    expect(screen.getByText('shell')).toBeTruthy();
  });

  it('asks who is listening once at a cold launch with two people and the setting on', async () => {
    useProfiles.setState({
      hydrated: true,
      profiles: two,
      activeProfileId: 'chris',
      askAtLaunch: true,
    });
    const view = await mount();
    expect(mockPush).toHaveBeenCalledWith('/profiles');
    await view.unmount();
    await mount();
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('does not ask with the setting off', async () => {
    useProfiles.setState({
      hydrated: true,
      profiles: two,
      activeProfileId: 'chris',
      askAtLaunch: false,
    });
    await mount();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens the picker when someone must be chosen, unless it is already open', async () => {
    useProfiles.setState({ hydrated: true, profiles: two, activeProfileId: 'sam' });
    await mount();
    expect(screen.getByText('shell')).toBeTruthy();
    // Sam (listening) left: nobody is active, so nobody's shell shows.
    await act(async () => useProfiles.setState({ profiles: [two[0]], activeProfileId: null }));
    expect(mockPush).toHaveBeenCalledWith('/profiles');
    expect(screen.queryByText('shell')).toBeNull();
    mockPush.mockClear();
    mockTop = 'profiles';
    await act(async () => useProfiles.setState({ activeProfileId: 'chris' }));
    await act(async () => useProfiles.setState({ activeProfileId: null }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a cold start with nobody chosen holds the shell and asks, every time the app is shown', async () => {
    // The persisted state after the person listening left (a reload, a cold start).
    useProfiles.setState({ hydrated: true, profiles: two, activeProfileId: null });
    const view = await mount();
    expect(screen.queryByText('shell')).toBeNull();
    expect(mockPush).toHaveBeenCalledTimes(1);
    // Web history's Back over the picker shows the app again: asked again.
    mockFocused = false;
    mockTop = 'profiles';
    await view.rerender(
      <AuthGate>
        <Text>shell</Text>
      </AuthGate>,
    );
    mockFocused = true;
    mockTop = '(app)';
    await view.rerender(
      <AuthGate>
        <Text>shell</Text>
      </AuthGate>,
    );
    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('shell')).toBeNull();
    // Once someone is chosen the launch question is not asked again.
    mockPush.mockClear();
    await act(async () => useProfiles.setState({ activeProfileId: 'chris', askAtLaunch: true }));
    expect(screen.getByText('shell')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
