import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  Redirect: () => null,
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
    await act(async () => useProfiles.setState({ chooseRequired: true }));
    expect(mockPush).toHaveBeenCalledWith('/profiles');
    mockPush.mockClear();
    mockTop = 'profiles';
    await act(async () => useProfiles.setState({ chooseRequired: false }));
    await act(async () => useProfiles.setState({ chooseRequired: true }));
    expect(mockPush).not.toHaveBeenCalled();
  });
});
