import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AuthGate } from '@/components/shell/auth-gate';
import { useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

// The `(app)` gate's kids half: a kids profile never mounts the shell (the root layout's
// `KidsRouteGuard` moves it to /kids; see kids-route-guard.test.tsx).
jest.mock('expo-router', () => ({ Redirect: () => null, useIsFocused: () => true }));

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

beforeEach(() => {
  // A user with known account flags, so the gate asks the server for nothing.
  useSession.setState({
    status: 'authenticated',
    user: {
      id: 1,
      username: 'leo',
      role: 'user',
      disabled: false,
      has_password: true,
      has_recovery: false,
    },
  });
});

afterEach(() => {
  useProfiles.setState({ profiles: [], activeProfileId: null, hydrated: false });
});

const shell = () =>
  render(
    <AuthGate>
      <Text>the shell</Text>
    </AuthGate>,
  );

it('renders the shell for a grown-up profile', async () => {
  setProfile(false);
  await shell();
  expect(screen.getByText('the shell')).toBeTruthy();
});

it('never mounts the shell for a kids profile', async () => {
  setProfile(true);
  await shell();
  expect(screen.queryByText('the shell')).toBeNull();
});

it('takes the shell away when the profile turns into a kids profile', async () => {
  setProfile(false);
  await shell();
  expect(screen.getByText('the shell')).toBeTruthy();
  await act(async () => setProfile(true));
  expect(screen.queryByText('the shell')).toBeNull();
});
