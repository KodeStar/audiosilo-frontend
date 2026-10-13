import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Keyboard } from 'react-native';

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
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual('@/components/ui/toast'),
  toast: (o: unknown) => mockToast(o),
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
import * as profilePin from '@/lib/profile-pin';
import { checkPin, setPin } from '@/lib/profile-pin';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { HouseholdPage } from '@/components/household/household-page';
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
      <HouseholdPage />
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

describe('Household page: on this device (Phase 8, a page since 8b-1)', () => {
  it('heads the page, and signs in someone who already has an account through connect', async () => {
    await mount();
    expect(screen.getByRole('header', { name: 'Household' })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'On this device' })).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sign in someone who already has an account' }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith('/connect?add=1&profile=new');
  });

  it('has no members section on a server without household_members (old servers)', async () => {
    mockCaps['a.1'] = { household: true };
    await mount();
    expect(screen.queryByTestId('household-members')).toBeNull();
    expect(screen.queryByText('Add someone to your household')).toBeNull();
  });

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

  it('never turns kids mode on for the last grown-up, and says why', async () => {
    await mount();
    await fireEvent(screen.getByLabelText('Kids mode for Leo'), 'onCheckedChange', true);
    // Chris is the only grown-up left: his switch is off limits, with the reason beside it.
    const chris = screen.getByLabelText('Kids mode for Chris');
    expect(chris.props.accessibilityState?.disabled ?? chris.props.disabled).toBe(true);
    expect(
      screen.getByText(/Someone on this device has to stay a grown-up, or nobody could leave/),
    ).toBeTruthy();
    await fireEvent(chris, 'onCheckedChange', true);
    expect(useProfiles.getState().profiles.find((p) => p.id === 'chris')?.kids).toBeUndefined();
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
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    await fireEvent.changeText(screen.getByTestId('pin-field'), '2222');
    await fireEvent.changeText(screen.getByTestId('pin-field'), '2222');
    await waitFor(async () => expect(await checkPin('leo', '2222')).toBe(true));
    // Saved: the number pad goes with the prompt (Android kept a keyboard up otherwise).
    await waitFor(() => expect(screen.queryByTestId('pin-field')).toBeNull());
    expect(dismiss).toHaveBeenCalled();
    dismiss.mockRestore();
  });

  it("lets the PIN row's description wrap beside Change and Remove", async () => {
    await setPin('leo', '1111');
    await mount();
    expect(screen.getByText('Asked when someone switches to Leo').props.numberOfLines).toBe(
      undefined,
    );
    // The words take the room the buttons leave (`flex-1`): a `shrink` column was cut to
    // one line on Android ("... switches to").
    const words = String(screen.getByTestId('household-pin-leo-text').props.className).split(' ');
    expect(words).toContain('flex-1');
    expect(words).not.toContain('shrink');
  });

  it('"Set a PIN" over a PIN the mirror lost asks for that PIN first (never overwrites it)', async () => {
    await setPin('leo', '1111');
    // A stale document (another tab, a failed write) dropped the mirror; the hash stays.
    useProfiles.setState({
      profiles: useProfiles
        .getState()
        .profiles.map((p) => (p.id === 'leo' ? { ...p, hasPin: undefined } : p)),
    });
    await mount();
    await fireEvent.press(screen.getByLabelText('Set a PIN for Leo'));
    expect(await screen.findByText("Enter Leo's current PIN")).toBeTruthy();
    expect(leo()?.hasPin).toBe(true);
    await fireEvent.changeText(screen.getByTestId('pin-field'), '9999');
    expect(await screen.findByText("That PIN doesn't match")).toBeTruthy();
    expect(await checkPin('leo', '1111')).toBe(true);
  });

  it('"Set a PIN" with an unreadable PIN store says so and never chooses a new one', async () => {
    await setPin('leo', '1111');
    useProfiles.setState({
      profiles: useProfiles
        .getState()
        .profiles.map((p) => (p.id === 'leo' ? { ...p, hasPin: undefined } : p)),
    });
    const read = jest.spyOn(profilePin, 'readPin').mockRejectedValue(new Error('locked'));
    await mount();
    await fireEvent.press(screen.getByLabelText('Set a PIN for Leo'));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "Couldn't check the PIN on this device. Try again.",
      }),
    );
    expect(screen.queryByTestId('pin-field')).toBeNull();
    read.mockRestore();
    expect(await checkPin('leo', '1111')).toBe(true);
  });

  it.each([
    ['Change', "Change Leo's PIN"],
    ['Remove', "Remove Leo's PIN"],
  ])(
    '%s over a mirror whose PIN is gone repairs the mirror and says there is none',
    async (_, label) => {
      // The mirror says PIN, the secure store has no hash (a restore without the store).
      await profilePin.clearPin('leo');
      useProfiles.setState({
        profiles: useProfiles
          .getState()
          .profiles.map((p) => (p.id === 'leo' ? { ...p, hasPin: true } : p)),
      });
      await mount();
      await fireEvent.press(screen.getByLabelText(label));
      await waitFor(() =>
        expect(mockToast).toHaveBeenCalledWith({
          title: "There's no PIN set for Leo on this device.",
        }),
      );
      expect(screen.queryByTestId('pin-field')).toBeNull();
      expect(leo()?.hasPin).toBeFalsy();
      expect(screen.getByLabelText('Set a PIN for Leo')).toBeTruthy();
    },
  );

  it('Change with an unreadable PIN store says it could not check, and asks nothing', async () => {
    await setPin('leo', '1111');
    const read = jest.spyOn(profilePin, 'readPin').mockRejectedValue(new Error('locked'));
    await mount();
    await fireEvent.press(screen.getByLabelText("Change Leo's PIN"));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "Couldn't check the PIN on this device. Try again.",
      }),
    );
    expect(screen.queryByTestId('pin-field')).toBeNull();
    expect(leo()?.hasPin).toBe(true);
    read.mockRestore();
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

  it('says who can sign a household member in again, never that they need a new invite', async () => {
    useSession.setState({
      connections: [
        conn('a.1', 'Hearthside', 'chris'),
        {
          ...conn('a.3', 'Hearthside', 'leo'),
          user: {
            id: 3,
            username: 'leo',
            role: 'user',
            has_password: false,
            has_recovery: false,
            managed_by: { id: 1, username: 'chris' },
            member_kind: 'kid',
          },
        } as unknown as Connection,
      ],
    });
    await mount();
    await fireEvent.press(screen.getByTestId('remove-person-leo'));
    expect(
      await screen.findByText(
        "Leo's account on Hearthside stays. chris can sign Leo in here again from the Household page, or set up a device just for Leo.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/new invite/)).toBeNull();
  });

  it("reads the household again on the person's server once they are removed (the owner's member devices)", async () => {
    await mount();
    client.setQueryData(qk.memberDevices('a.1', 3), []);
    client.setQueryData(qk.householdMembers('a.1'), { allowed: true, max: 6, members: [] });
    client.setQueryData(qk.myDevices('a.1'), []);
    client.setQueryData(qk.memberDevices('b.1', 3), []);
    await fireEvent.press(screen.getByTestId('remove-person-leo'));
    await fireEvent.press(await screen.findByTestId('remove-person-confirm'));
    await waitFor(() => expect(leo()).toBeUndefined());
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated === true;
    expect(stale(qk.memberDevices('a.1', 3))).toBe(true);
    expect(stale(qk.householdMembers('a.1'))).toBe(true);
    expect(stale(qk.myDevices('a.1'))).toBe(true);
    // Another server's household is untouched.
    expect(stale(qk.memberDevices('b.1', 3))).toBe(false);
  });

  it("describes a household member's kids mode by who manages them, never the server's admin", async () => {
    useSession.setState({
      connections: [
        conn('a.1', 'Hearthside', 'chris'),
        {
          ...conn('a.3', 'Hearthside', 'leo'),
          user: {
            id: 3,
            username: 'leo',
            has_password: false,
            has_recovery: false,
            managed_by: { id: 1, username: 'chris' },
            member_kind: 'kid',
          },
        } as unknown as Connection,
      ],
    });
    useProfiles.setState({
      profiles: [
        { id: 'chris', name: 'Chris', connectionIds: ['a.1'] },
        { id: 'leo', name: 'Leo', connectionIds: ['a.3'], kids: { bedtime: '19:30' } },
      ],
    });
    await mount();
    client.setQueryData(qk.libraries('a.3'), []);
    await waitFor(() =>
      expect(
        screen.getByText('Nothing to pick. chris shares stories from the Household page.'),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText(
        'The stories chris shares, as big covers, with a bedtime and no settings or search. Leaving needs a grown-up.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Shown when chris shares no collections')).toBeTruthy();
    expect(screen.queryByText(/Ask the server's admin/)).toBeNull();
  });

  it('heads each section the same way (a section heading, not a card title)', async () => {
    mockCaps['a.1'] = { household: true };
    await mount();
    const device = screen.getByRole('header', { name: 'On this device' });
    const sharing = screen.getByRole('header', { name: 'Listening in the house' });
    expect(device.props.className).toContain('text-xl');
    expect(sharing.props.className).toBe(device.props.className);
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
