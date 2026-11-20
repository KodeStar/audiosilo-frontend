import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { MyDevice, User } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

const mockApi = { setPassword: jest.fn(), me: jest.fn() };
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));
// The devices read again after a change (`undefined`: no list, or no answer).
const mockReadDevices = jest.fn<Promise<MyDevice[] | undefined>, []>();
// The devices list as it was before the change, and the server's version.
let mockDevicesBefore: MyDevice[] | undefined;
let mockVersion: string | undefined;
jest.mock('@/api/hooks', () => ({
  useReadMyDevicesAgain: () => mockReadDevices,
  useMyDevices: () => ({ data: mockDevicesBefore }),
  useServerInfo: () => ({ data: mockVersion ? { version: mockVersion } : undefined }),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

let mockUser: User;
const mockSetConnectionUser = jest.fn(async () => {});
jest.mock('@/stores/session', () => ({
  useSession: (selector: (s: unknown) => unknown) =>
    selector({
      connections: [{ id: 'c', user: mockUser }],
      setConnectionUser: mockSetConnectionUser,
    }),
}));
// A change ends the account's open pairing tokens: the one on its way to a watch is forgotten.
const mockForgetPair = jest.fn();
jest.mock('@/watch/watch-store', () => ({ forgetPair: (id: string) => mockForgetPair(id) }));

/* eslint-disable import/first */
import { PasswordCard, PasswordDialog } from './password-card';
import { usePasswordEditor } from './use-password-editor';
/* eslint-enable import/first */

function Harness() {
  const editor = usePasswordEditor('c');
  return (
    <>
      <PasswordCard editor={editor} user={mockUser} />
      <PasswordDialog editor={editor} />
    </>
  );
}

const device = (over: Partial<MyDevice>): MyDevice => ({
  id: 1,
  kind: 'session',
  name: 'Phone',
  client: null,
  created_at: '2026-10-01T00:00:00.000Z',
  last_seen: null,
  last_ip: '',
  current: false,
  ...over,
});

/** Changes an existing password through the dialog. */
async function changePassword() {
  mockUser = user({ has_password: true });
  await mountWithPortal(<Harness />);
  await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
  await fireEvent.changeText(screen.getByLabelText('Current password'), 'oldpassword');
  await fireEvent.changeText(screen.getByLabelText('New password'), 'newpassword');
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
}

const user = (over: Partial<User>): User => ({
  id: 1,
  username: 'chris',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.setPassword.mockResolvedValue(undefined);
  mockApi.me.mockResolvedValue(user({ has_password: true }));
  mockReadDevices.mockResolvedValue([device({ id: 9, current: true })]);
  mockDevicesBefore = [device({ id: 9, current: true }), device({ id: 3 })];
  mockVersion = '2.7.0';
});

describe('password card and dialog', () => {
  it('sets a first password without asking for a current one', async () => {
    mockUser = user({ has_password: false });
    await mountWithPortal(<Harness />);
    expect(screen.getByText('Not set')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Set a password' }));
    expect(screen.queryByLabelText('Current password')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('New password'), 'longenough');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApi.setPassword).toHaveBeenCalledWith('longenough', undefined));
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Password set',
      description: 'Your other devices stay signed in.',
    });
    // A first password ends no session, nor a pairing token: nothing to read again or forget.
    expect(mockReadDevices).not.toHaveBeenCalled();
    expect(mockForgetPair).not.toHaveBeenCalled();
    // has_password is refreshed on this connection.
    await waitFor(() =>
      expect(mockSetConnectionUser).toHaveBeenCalledWith('c', expect.objectContaining({})),
    );
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('changes a password only with the current one', async () => {
    mockUser = user({ has_password: true });
    await mountWithPortal(<Harness />);
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
    await fireEvent.changeText(screen.getByLabelText('New password'), 'newpassword');
    // Disabled until the current password is in.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Current password'), 'oldpassword');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockApi.setPassword).toHaveBeenCalledWith('newpassword', 'oldpassword'),
    );
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Password changed' }));
    // The server ended the open pairing tokens with the other sessions (fe#219).
    expect(mockForgetPair).toHaveBeenCalledWith('c');
  });

  it.each<[string, MyDevice[] | undefined, string]>([
    [
      'says the others are signed out',
      [device({ id: 9, current: true })],
      'Your other devices are signed out. This one stays signed in.',
    ],
    [
      'says the others stay signed in when the server kept them (an older server)',
      [device({ id: 9, current: true }), device({ id: 3 })],
      'Your other devices stay signed in.',
    ],
    [
      'claims only this device when the devices cannot be read',
      undefined,
      'This device stays signed in.',
    ],
  ])('reads the devices again after a change, and %s', async (_, devices, description) => {
    mockReadDevices.mockResolvedValue(devices);
    await changePassword();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({ title: 'Password changed', description }),
    );
    expect(mockReadDevices).toHaveBeenCalledTimes(1);
  });

  // server#285: "signed out" only when the change ended some: never with no other device.
  it.each<[string, MyDevice[] | undefined]>([
    ['no other device was signed in', [device({ id: 9, current: true })]],
    ['the list was not known', undefined],
  ])('claims only this device when %s before the change', async (_, before) => {
    mockDevicesBefore = before;
    await changePassword();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Password changed',
        description: 'This device stays signed in.',
      }),
    );
  });

  // server#285: a server before server#281 (2.6.0) ends no pairing code on a change.
  it('keeps the pairing code on its way to a watch on a server before 2.6.0', async () => {
    mockVersion = '2.5.1';
    await changePassword();
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockForgetPair).not.toHaveBeenCalled();
  });

  it('says why a short password from the keyboard is not saved', async () => {
    mockUser = user({ has_password: false });
    await mountWithPortal(<Harness />);
    await fireEvent.press(screen.getByRole('button', { name: 'Set a password' }));
    const field = screen.getByLabelText('New password');
    await fireEvent.changeText(field, 'short');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await fireEvent(field, 'submitEditing');
    expect(screen.getByText('Password must be at least 8 characters.')).toBeTruthy();
    expect(mockApi.setPassword).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with the server's reason when it refuses", async () => {
    mockUser = user({ has_password: true });
    mockApi.setPassword.mockRejectedValue(new ApiError(401, 'current password is incorrect'));
    await mountWithPortal(<Harness />);
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
    await fireEvent.changeText(screen.getByLabelText('Current password'), 'wrongpassword');
    await fireEvent.changeText(screen.getByLabelText('New password'), 'newpassword');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('current password is incorrect')).toBeTruthy();
    expect(screen.getByLabelText('New password')).toBeTruthy();
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockForgetPair).not.toHaveBeenCalled();
  });

  // The server names a wrong current password (`current_password_incorrect`): said in the
  // listener's language under the Current password field, never the server's English under
  // the new one.
  it('says a wrong current password under its own field, in words of its own', async () => {
    mockUser = user({ has_password: true });
    mockApi.setPassword.mockRejectedValue(
      new ApiError(401, 'current password is incorrect', 'current_password_incorrect'),
    );
    await mountWithPortal(<Harness />);
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
    await fireEvent.changeText(screen.getByLabelText('Current password'), 'wrongpassword');
    await fireEvent.changeText(screen.getByLabelText('New password'), 'newpassword');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("That isn't your current password.")).toBeTruthy();
    expect(screen.queryByText('current password is incorrect')).toBeNull();
    expect(screen.getByLabelText('Current password').props['aria-invalid']).toBe(true);
    expect(screen.getByLabelText('New password').props['aria-invalid']).toBeUndefined();
    // Another try clears it.
    mockApi.setPassword.mockResolvedValue(undefined);
    await fireEvent.changeText(screen.getByLabelText('Current password'), 'rightpassword');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText("That isn't your current password.")).toBeNull());
  });

  it('says only what is true of an account without a password, never "an invite code" (D8)', async () => {
    mockUser = user({ has_password: false });
    const view = await mountWithPortal(<Harness />);
    expect(
      screen.getByText("You haven't set a password. Set one so you can sign in on a new device."),
    ).toBeTruthy();
    expect(screen.queryByText(/invite code/)).toBeNull();
    await view.unmount();

    // A grown-up household member: their owner set the account up.
    mockUser = user({
      has_password: false,
      managed_by: { id: 2, username: 'adam' },
      member_kind: 'grownup',
    });
    await mountWithPortal(<Harness />);
    expect(
      screen.getByText(
        'adam set up this account, so it has no password yet. Set one to sign in on a new device yourself.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set a password' })).toBeTruthy();
  });

  it("offers a kid's account no password (the server refuses one): its owner signs it in", async () => {
    mockUser = user({
      has_password: false,
      managed_by: { id: 2, username: 'adam' },
      member_kind: 'kid',
    });
    await mountWithPortal(<Harness />);
    expect(
      screen.getByText("A kid's account has no password. adam signs it in on a new device."),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set a password' })).toBeNull();
  });

  it('cancelling clears what was typed', async () => {
    mockUser = user({ has_password: false });
    await mountWithPortal(<Harness />);
    await fireEvent.press(screen.getByRole('button', { name: 'Set a password' }));
    await fireEvent.changeText(screen.getByLabelText('New password'), 'halfwritten');
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Set a password' }));
    expect(screen.getByLabelText('New password').props.value).toBe('');
  });
});
