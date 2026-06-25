import { act, render, waitFor } from '@testing-library/react-native';

import type { User } from '@/api/types';

const mockApi = { generateRecoveryCode: jest.fn(), me: jest.fn() };
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));

let mockSessionState: { user: User | null; setUser: jest.Mock };
jest.mock('@/stores/session', () => ({
  useSession: (selector: (s: unknown) => unknown) => selector(mockSessionState),
}));

// eslint-disable-next-line import/first
import { useRecoveryCode } from './use-recovery-code';

// renderHook is incompatible with this jest-expo + React 19 setup, so mount a probe
// component (render works) that re-captures the hook value on every render. The
// mount is wrapped in an awaited act so it doesn't overlap the test's own act calls.
async function mountHook<T>(useHook: () => T): Promise<() => T> {
  const ref: { value: T | null } = { value: null };
  function Probe() {
    ref.value = useHook();
    return null;
  }
  await act(async () => {
    render(<Probe />);
  });
  return () => ref.value as T;
}

const user = (over: Partial<User>): User => ({
  id: 1,
  username: 'kid',
  role: 'user',
  disabled: false,
  has_password: false,
  has_recovery: false,
  ...over,
});

beforeEach(() => {
  mockApi.generateRecoveryCode.mockReset();
  mockApi.me.mockReset();
  mockSessionState = { user: user({}), setUser: jest.fn() };
});

describe('useRecoveryCode', () => {
  it('mints immediately when the user has no existing code', async () => {
    mockApi.generateRecoveryCode.mockResolvedValue('REC-123');
    mockApi.me.mockResolvedValue(user({ has_recovery: true }));
    const hook = await mountHook(() => useRecoveryCode());

    await act(async () => {
      hook().requestGenerate();
    });

    await waitFor(() => expect(hook().code).toBe('REC-123'));
    expect(hook().confirmRegen).toBe(false);
    expect(mockSessionState.setUser).toHaveBeenCalled(); // refreshed has_recovery
  });

  it('confirms before replacing an existing code', async () => {
    mockSessionState.user = user({ has_recovery: true });
    mockApi.generateRecoveryCode.mockResolvedValue('REC-NEW');
    const hook = await mountHook(() => useRecoveryCode());

    await act(async () => {
      hook().requestGenerate();
    });
    // Replacing destroys the old code, so it asks first rather than minting.
    expect(hook().confirmRegen).toBe(true);
    expect(mockApi.generateRecoveryCode).not.toHaveBeenCalled();

    await act(async () => {
      hook().confirmGenerate();
    });
    await waitFor(() => expect(hook().code).toBe('REC-NEW'));
    expect(hook().confirmRegen).toBe(false);
  });

  it('surfaces an error when minting fails (and mints no code)', async () => {
    mockApi.generateRecoveryCode.mockRejectedValue(new Error('nope'));
    const hook = await mountHook(() => useRecoveryCode());

    await act(async () => {
      hook().requestGenerate();
    });

    await waitFor(() => expect(hook().error).toBeTruthy());
    expect(hook().code).toBeNull();
  });
});
