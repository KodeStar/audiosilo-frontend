import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

const mockRouter = {
  push: jest.fn(),
  back: jest.fn(),
  dismissTo: jest.fn(),
  canGoBack: () => true,
};
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));
jest.mock('@/lib/root-stack', () => ({ popTabToRoot: jest.fn() }));
jest.mock('@/playback/store', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ...require('@/testing/player-store-mock').createPlayerStoreMock(),
  teardownBeforeTokenRevoke: jest.fn(async () => {}),
}));
const mockSignOut = jest.fn(async (id: string) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  await require('@/stores/session').useSession.getState().removeConnection(id);
});
jest.mock('@/components/account/use-sign-out', () => ({
  ...jest.requireActual('@/components/account/use-sign-out'),
  signOutConnection: (id: string) => mockSignOut(id),
}));
const mockCaps: Record<string, { household?: boolean }> = {};
jest.mock('@/api/hooks', () => ({
  ...jest.requireActual('@/api/hooks'),
  useCapabilitiesAll: () => mockCaps,
}));
jest.mock('@/components/house/house-sharing-row', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    HouseSharingRow: ({ connectionId }: { connectionId: string }) => (
      <Text>{`sharing-${connectionId}`}</Text>
    ),
  };
});

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { formatTimeOfDay } from '@/lib/format';
import { checkPin, setPin } from '@/lib/profile-pin';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { HouseholdPane } from './household-pane';
/* eslint-enable import/first */

const conn = (id: string, name: string, username: string) =>
  ({
    id,
    serverId: id.split('.')[0],
    name,
    serverUrl: 'u',
    token: 't',
    user: { id: Number(id.split('.')[1]), username, has_password: true, has_recovery: false },
  }) as unknown as Connection;

let client: QueryClient;
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(qk.libraries('a.3'), [
    { id: 4, name: 'Kids' },
    { id: 5, name: 'Grown-ups' },
  ]);
  await mountWithPortal(
    <QueryClientProvider client={client}>
      <HouseholdPane />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  resetProfilesForTests();
  for (const k of Object.keys(mockCaps)) delete mockCaps[k];
  useSession.setState({
    status: 'authenticated',
    connections: [
      conn('a.1', 'Hearthside', 'chris'),
      conn('b.1', "Maya's Shelf", 'chris'),
      conn('a.3', 'Hearthside', 'leo'),
    ],
    defaultConnectionId: 'a.1',
  });
  useProfiles.setState({
    hydrated: true,
    profiles: [
      { id: 'chris', name: 'Chris', connectionIds: ['a.1', 'b.1'] },
      { id: 'leo', name: 'Leo', connectionIds: ['a.3'] },
    ],
    activeProfileId: 'chris',
    askAtLaunch: true,
  });
});

const leo = () => useProfiles.getState().profiles.find((p) => p.id === 'leo');

describe('Settings > Household', () => {
  it('lists the people on this device, the one listening marked', async () => {
    await mount();
    expect(screen.getByTestId('household-person-chris')).toBeTruthy();
    expect(screen.getByTestId('household-person-leo')).toBeTruthy();
    expect(screen.getByText('Hearthside + 1 more')).toBeTruthy();
    expect(screen.getByLabelText('Switch to Leo')).toBeTruthy();
  });

  it('turns kids mode on with the default bedtime, picks its library and moves the bedtime', async () => {
    await mount();
    await fireEvent(screen.getByLabelText('Kids mode for Leo'), 'onCheckedChange', true);
    expect(leo()?.kids).toEqual({ bedtime: '19:30' });
    expect(screen.getByText('The first one (Kids)')).toBeTruthy();
    // One clock for every bedtime time: the reader's (12 h in this test's locale), never a
    // fixed 24 h "06:00" next to "7:30 PM".
    expect(
      screen.getByText(
        `From then until ${formatTimeOfDay('06:00')}, playing starts a 20 minute sleep timer`,
      ),
    ).toBeTruthy();
    expect(formatTimeOfDay('06:00')).toBe('6:00 AM');
    await fireEvent.press(screen.getByLabelText('Bedtime, 30 minutes later'));
    expect(leo()?.kids?.bedtime).toBe('20:00');
    await fireEvent(screen.getByLabelText('Kids mode for Leo'), 'onCheckedChange', false);
    expect(leo()?.kids).toBeUndefined();
  });

  it('sets a PIN, and asks for the current one before removing it', async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText('Set a PIN for Leo'));
    await fireEvent.changeText(screen.getByTestId('pin-field'), '1234');
    await fireEvent.changeText(screen.getByTestId('pin-field'), '1234');
    await waitFor(() => expect(leo()?.hasPin).toBe(true));
    expect(await checkPin('leo', '1234')).toBe(true);

    await fireEvent.press(screen.getByLabelText("Remove Leo's PIN"));
    expect(await screen.findByText("Enter Leo's current PIN")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('pin-field'), '1234');
    await waitFor(() => expect(leo()?.hasPin).toBeUndefined());
  });

  it('changing a PIN asks the current one, then the new one twice', async () => {
    await setPin('leo', '1111');
    await mount();
    await fireEvent.press(screen.getByLabelText("Change Leo's PIN"));
    await fireEvent.changeText(screen.getByTestId('pin-field'), '1111');
    expect(await screen.findByText('Choose a 4-digit PIN')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('pin-field'), '2222');
    await fireEvent.changeText(screen.getByTestId('pin-field'), '2222');
    await waitFor(async () => expect(await checkPin('leo', '2222')).toBe(true));
  });

  it('renames a person on this device', async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText('Rename Leo'));
    await fireEvent.changeText(screen.getByTestId('rename-field'), 'Leo junior');
    await fireEvent.press(screen.getByText('Save'));
    expect(leo()?.name).toBe('Leo junior');
  });

  it('removes a person: signs out each of their servers, then forgets them', async () => {
    await mount();
    await fireEvent.press(screen.getByTestId('remove-person-leo'));
    expect(await screen.findByText('Remove Leo from this device?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('remove-person-confirm'));
    await waitFor(() => expect(leo()).toBeUndefined());
    expect(mockSignOut).toHaveBeenCalledWith('a.3');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('warns about a server where they have no password', async () => {
    useSession.setState({
      connections: [
        conn('a.1', 'Hearthside', 'chris'),
        {
          ...conn('a.3', 'Hearthside', 'leo'),
          user: { id: 3, username: 'leo', role: 'user', has_password: false, has_recovery: false },
        } as unknown as Connection,
      ],
    });
    await mount();
    await fireEvent.press(screen.getByTestId('remove-person-leo'));
    expect(await screen.findByText(/Leo has no password on Hearthside/)).toBeTruthy();
  });

  it('turns asking who is listening off', async () => {
    await mount();
    await fireEvent(
      screen.getByLabelText("Ask who's listening when the app opens"),
      'onCheckedChange',
      false,
    );
    expect(useProfiles.getState().askAtLaunch).toBe(false);
  });

  it("offers house sharing for the listener's servers that have it, and only theirs", async () => {
    mockCaps['a.1'] = { household: true };
    mockCaps['b.1'] = { household: false };
    mockCaps['a.3'] = { household: true };
    await mount();
    expect(screen.getByText('sharing-a.1')).toBeTruthy();
    expect(screen.queryByText('sharing-b.1')).toBeNull();
    // Leo's server is Leo's to share.
    expect(screen.queryByText('sharing-a.3')).toBeNull();
  });

  it('says when none of the servers offers sharing', async () => {
    mockCaps['a.1'] = {};
    mockCaps['b.1'] = {};
    await mount();
    expect(screen.getByText('None of your servers offers this yet.')).toBeTruthy();
  });
});
