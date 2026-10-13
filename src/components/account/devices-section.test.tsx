import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { ApiError } from '@/api/client';
import type { MyDevice } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';
import { expectNativeTarget } from '@/testing/touch-target';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

type DevicesQuery = {
  data?: MyDevice[];
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  refetch: jest.Mock;
};
let mockDevices: DevicesQuery;
const mockRevoke = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useMyDevices: () => mockDevices,
    useRevokeMyDevice: () => ({ mutateAsync: mockRevoke, isPending: false }),
  };
});

/* eslint-disable import/first */
import { CapabilityError } from '@/api/hooks';

import { DevicesSection } from './devices-section';
/* eslint-enable import/first */

const NOW = Date.now();
const device = (over: Partial<MyDevice>): MyDevice => ({
  id: 1,
  kind: 'session',
  name: 'Phone',
  client: { app: 'AudioSilo', version: '1.4.2', platform: 'ios' },
  created_at: '2026-10-01T10:00:00Z',
  last_seen: new Date(NOW - 2 * 3600_000).toISOString(),
  last_ip: '',
  current: false,
  ...over,
});

const here = device({ id: 10, name: 'Chris iPhone', current: true });
const laptop = device({
  id: 11,
  name: 'Work laptop',
  client: { app: 'AudioSilo', version: '1.4.0', platform: 'web' },
});
const key = device({ id: 12, kind: 'api', name: 'Home Assistant', client: null });

const loaded = (data: MyDevice[]): DevicesQuery => ({
  data,
  isPending: false,
  isError: false,
  isSuccess: true,
  refetch: jest.fn(),
});

const mount = () => mountWithPortal(<DevicesSection connectionId="c" serverName="Hearthside" />);

const OS = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks();
  mockDevices = loaded([laptop, key, here]);
  Platform.OS = OS;
});
afterAll(() => {
  Platform.OS = OS;
});

/** Signs the laptop out through its row and the confirmation. */
async function signOutLaptop() {
  await fireEvent.press(screen.getByRole('button', { name: 'Sign out Work laptop' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
}

describe('DevicesSection', () => {
  it('lists the sessions, this device first and marked, never an API key', async () => {
    await mount();
    const rows = screen.getAllByTestId(/^device-/).map((r) => r.props.testID);
    expect(rows).toEqual(['device-10', 'device-11']);
    expect(screen.queryByText('Home Assistant')).toBeNull();
    const mine = within(screen.getByTestId('device-10'));
    expect(mine.getByText('This device')).toBeTruthy();
    expect(mine.getByText('AudioSilo 1.4.2 · iOS · active now')).toBeTruthy();
    expect(
      within(screen.getByTestId('device-11')).getByText(
        'AudioSilo 1.4.0 · Browser · last seen 2 hours ago',
      ),
    ).toBeTruthy();
  });

  // Revoking this device's own token would kill it before the sign-out teardown (final
  // position, queued progress) runs: its row must offer nothing.
  it('never offers the current device a sign-out, so it can never be revoked here', async () => {
    await mount();
    expect(within(screen.getByTestId('device-10')).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out Chris iPhone' })).toBeNull();
    // The only sign-out on the list is the other device's, and it revokes that one.
    mockRevoke.mockResolvedValue({ current: false });
    expect(screen.getAllByRole('button', { name: /^Sign out / })).toHaveLength(1);
    await signOutLaptop();
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledTimes(1));
    expect(mockRevoke).toHaveBeenCalledWith({ id: 11, alsoMembers: false });
    expect(mockRevoke).not.toHaveBeenCalledWith(expect.objectContaining({ id: 10 }));
  });

  it('signs another device out after a confirmation and says so', async () => {
    mockRevoke.mockResolvedValue({ current: false });
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out Work laptop' }));
    expect(screen.getByText('Sign out Work laptop?')).toBeTruthy();
    expect(mockRevoke).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Signed out Work laptop',
        description: 'It needs to sign in again to reach Hearthside.',
      }),
    );
  });

  it('cancelling the confirmation signs nothing out', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out Work laptop' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('says what went wrong and that nothing changed when the server fails', async () => {
    mockRevoke.mockRejectedValue(new ApiError(500, 'boom'));
    await mount();
    await signOutLaptop();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "Couldn't sign out Work laptop",
        description: "Hearthside didn't answer. Nothing changed, so try again.",
      }),
    );
  });

  it('reads a 404 as already signed out and refreshes the list', async () => {
    mockRevoke.mockRejectedValue(new ApiError(404, 'device not found'));
    await mount();
    await signOutLaptop();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Work laptop was already signed out' }),
      ),
    );
    expect(mockDevices.refetch).toHaveBeenCalled();
  });

  it('reports nothing for a request that was never sent (no capability)', async () => {
    mockRevoke.mockRejectedValue(new CapabilityError('my_devices'));
    await mount();
    await signOutLaptop();
    await waitFor(() => expect(mockRevoke).toHaveBeenCalled());
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('shows a skeleton while loading and a retry when the list fails', async () => {
    mockDevices = { ...loaded([]), data: undefined, isPending: true, isSuccess: false };
    const view = await mount();
    expect(screen.getByTestId('devices-loading')).toBeTruthy();

    mockDevices = { ...loaded([]), data: undefined, isError: true, isSuccess: false };
    await view.rerender(<DevicesSection connectionId="c" serverName="Hearthside" />);
    expect(screen.getByText("Couldn't load your devices from Hearthside.")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockDevices.refetch).toHaveBeenCalled();
  });

  it('says when only this device is signed in', async () => {
    mockDevices = loaded([here]);
    await mount();
    expect(screen.getByText('Only this device is signed in.')).toBeTruthy();
  });

  it('names an unnamed device and an app that has not reported yet', async () => {
    mockDevices = loaded([here, device({ id: 20, name: ' ', client: null, last_seen: null })]);
    await mount();
    const row = within(screen.getByTestId('device-20'));
    expect(row.getByText('Unnamed device')).toBeTruthy();
    expect(row.getByText('App not reported yet · not seen since it signed in')).toBeTruthy();
  });

  it('gives the sign-out a real 44 pt frame on native', async () => {
    Platform.OS = 'ios';
    await mount();
    expectNativeTarget(screen.getByRole('button', { name: 'Sign out Work laptop' }));
  });
});

describe('DevicesSection: household members signed in on a device (8b-1)', () => {
  const phone = device({
    id: 30,
    name: 'Kitchen phone',
    member_sign_ins: [
      { id: 12, name: 'Evie' },
      { id: 13, name: 'Ellis' },
    ],
  });

  it('offers "Also sign out Evie and Ellis", ticked, and passes alsoMembers', async () => {
    mockDevices = loaded([here, phone]);
    mockRevoke.mockResolvedValue({ current: false, members_signed_out: 2 });
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out Kitchen phone' }));
    const tick = screen.getByTestId('revoke-also-members');
    expect(tick).toBeChecked();
    expect(within(tick).getByText('Also sign out Evie and Ellis on that device')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith({ id: 30, alsoMembers: true }));
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Signed out Kitchen phone',
      description:
        'It needs to sign in again to reach Hearthside. 2 people in your household were signed out with it.',
    });
  });

  it('unticked, signs the device out alone (the members stay signed in there)', async () => {
    mockDevices = loaded([here, phone]);
    mockRevoke.mockResolvedValue({ current: false, members_signed_out: 0 });
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out Kitchen phone' }));
    await fireEvent.press(screen.getByTestId('revoke-also-members'));
    expect(screen.getByTestId('revoke-also-members')).not.toBeChecked();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith({ id: 30, alsoMembers: false }));
  });

  it('asks afresh, ticked, for the next device', async () => {
    const tablet = device({ id: 31, name: 'Tablet', member_sign_ins: [{ id: 12, name: 'Evie' }] });
    mockDevices = loaded([here, phone, tablet]);
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out Kitchen phone' }));
    await fireEvent.press(screen.getByTestId('revoke-also-members'));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out Tablet' }));
    const tick = screen.getByTestId('revoke-also-members');
    expect(tick).toBeChecked();
    expect(within(tick).getByText('Also sign out Evie on that device')).toBeTruthy();
  });

  it('shows no tick, and sends the plain id, for a device with no member sign-ins', async () => {
    mockDevices = loaded([here, laptop]);
    mockRevoke.mockResolvedValue({ current: false });
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out Work laptop' }));
    expect(screen.queryByTestId('revoke-also-members')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out device' }));
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith({ id: 11, alsoMembers: false }));
  });

  it('never offers this device a sign-out, member sign-ins or not', async () => {
    mockDevices = loaded([{ ...here, member_sign_ins: [{ id: 12, name: 'Evie' }] }, laptop]);
    await mount();
    expect(within(screen.getByTestId('device-10')).queryByRole('button')).toBeNull();
  });
});
