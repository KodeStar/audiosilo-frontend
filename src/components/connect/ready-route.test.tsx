import { act, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

let mockParams: Record<string, unknown> = {};
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams }));
jest.mock('@/api/provider', () => ({
  ConnectionScope: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/components/connect/ready-screen', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    ReadyScreen: ({ connectionId }: { connectionId: string }) => (
      <Text>{`ready-${connectionId}`}</Text>
    ),
  };
});
jest.mock('@/components/shell/leave-onboarding', () => {
  const { Text } = jest.requireActual('react-native');
  return { LeaveOnboarding: () => <Text>leave</Text> };
});
jest.mock('@/components/profiles/other-person-gate', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    OtherPersonGate: ({ profile }: { profile: { name: string } }) => (
      <Text>{`gate-${profile.name}`}</Text>
    ),
  };
});

/* eslint-disable import/first */
import ReadyRoute from '@/app/connect/ready';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';
/* eslint-enable import/first */

const conn = (id: string) =>
  ({ id, serverUrl: 'u', name: id, token: 't', user: { id: 1 } }) as unknown as Connection;

beforeEach(() => {
  resetProfilesForTests();
  useSession.setState({ connections: [conn('a.1'), conn('a.2')], defaultConnectionId: 'a.1' });
  useProfiles.setState({
    hydrated: true,
    activeProfileId: 'me',
    profiles: [
      { id: 'me', name: 'Me', connectionIds: ['a.1'] },
      { id: 'bea', name: 'Bea', connectionIds: ['a.2'], hasPin: true },
    ],
  });
});

async function mount() {
  await act(async () => {
    render(<ReadyRoute />);
  });
}

it("shows the listener's own new library", async () => {
  mockParams = { connection: 'a.1' };
  await mount();
  expect(screen.getByText('ready-a.1')).toBeTruthy();
});

it("never shows another person's library and progress: their gate instead", async () => {
  mockParams = { connection: 'a.2' };
  await mount();
  expect(screen.getByText('gate-Bea')).toBeTruthy();
  expect(screen.queryByText('ready-a.2')).toBeNull();
});

it('goes to the app for a connection that is not signed in, or none', async () => {
  mockParams = { connection: 'gone.1' };
  await mount();
  expect(screen.getByText('leave')).toBeTruthy();
  mockParams = {};
  await mount();
  expect(screen.getAllByText('leave').length).toBeGreaterThan(0);
});
