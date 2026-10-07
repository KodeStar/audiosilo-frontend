import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { User } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

const mockApi = { setPassword: jest.fn(), me: jest.fn() };
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));
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
      <PasswordCard editor={editor} />
      <PasswordDialog editor={editor} />
    </>
  );
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
