import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { MyDevice, User } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

const mockApi = { setPassword: jest.fn(), me: jest.fn() };
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));
// The devices read again after a change (`undefined`: no list, or no answer).
const mockReadDevices = jest.fn<Promise<MyDevice[] | undefined>, []>();
jest.mock('@/api/hooks', () => ({ useReadMyDevicesAgain: () => mockReadDevices }));
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
    // A first password ends no session: nothing to read again.
    expect(mockReadDevices).not.toHaveBeenCalled();
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
  });

  it('reads the devices again after a change, and says the others are signed out', async () => {
    await changePassword();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Password changed',
        description: 'Your other devices are signed out. This one stays signed in.',
      }),
    );
    expect(mockReadDevices).toHaveBeenCalledTimes(1);
  });

  it('says the others stay signed in when the server kept them (an older server)', async () => {
    mockReadDevices.mockResolvedValue([device({ id: 9, current: true }), device({ id: 3 })]);
    await changePassword();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Password changed',
        description: 'Your other devices stay signed in.',
      }),
    );
  });

  it('claims only this device when the devices cannot be read', async () => {
    mockReadDevices.mockResolvedValue(undefined);
    await changePassword();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Password changed',
        description: 'This device stays signed in.',
      }),
    );
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
