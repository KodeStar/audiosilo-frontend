import { act, render, waitFor } from '@testing-library/react-native';

import type { User } from '@/api/types';

const mockApi = { logout: jest.fn(), me: jest.fn() };
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));

// The session store is driven directly here: the mock runs the selector against a
// controlled state object so each test sets the user + spies on logout/setUser.
let mockSessionState: { user: User | null; setUser: jest.Mock; logout: jest.Mock };
jest.mock('@/stores/session', () => ({
  useSession: (selector: (s: unknown) => unknown) => selector(mockSessionState),
}));

// signOut stops playback for the connection being revoked; mock the player store so
// this test (focused on the recovery-warning decision) doesn't pull in the native engine.
jest.mock('@/playback/store', () => ({ stopPlaybackForServer: jest.fn(async () => {}) }));

// eslint-disable-next-line import/first
import { useSignOut } from './use-sign-out';

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
  has_password: true,
  has_recovery: false,
  ...over,
});

// A session persisted before the recovery flags existed carries them as undefined.
const flaglessUser = { id: 1, username: 'kid', role: 'user', disabled: false } as unknown as User;

beforeEach(() => {
  mockApi.logout.mockReset().mockResolvedValue(undefined);
  mockApi.me.mockReset();
  mockSessionState = {
    user: null,
    setUser: jest.fn(),
    logout: jest.fn().mockResolvedValue(undefined),
  };
});

describe('useSignOut', () => {
  it('warns instead of signing out when the account would be stranded', async () => {
    mockSessionState.user = user({ has_password: false, has_recovery: false });
    const hook = await mountHook(() => useSignOut());

    await act(async () => {
      await hook().requestSignOut();
    });

    expect(hook().confirmVisible).toBe(true);
    expect(mockSessionState.logout).not.toHaveBeenCalled();
  });

  it('signs out directly when the user still has a credential', async () => {
    mockSessionState.user = user({ has_password: true });
    const hook = await mountHook(() => useSignOut());

    await act(async () => {
      await hook().requestSignOut();
    });

    await waitFor(() => expect(mockSessionState.logout).toHaveBeenCalled());
    expect(hook().confirmVisible).toBe(false);
  });

  it('refreshes unknown flags from /me before deciding (and warns when stranded)', async () => {
    mockSessionState.user = flaglessUser;
    mockApi.me.mockResolvedValue(user({ has_password: false, has_recovery: false }));
    const hook = await mountHook(() => useSignOut());

    await act(async () => {
      await hook().requestSignOut();
    });

    expect(mockApi.me).toHaveBeenCalled();
    expect(mockSessionState.setUser).toHaveBeenCalled();
    expect(hook().confirmVisible).toBe(true);
  });

  it('falls back to signing out (no warning) when /me is unreachable', async () => {
    mockSessionState.user = flaglessUser;
    mockApi.me.mockRejectedValue(new Error('offline'));
    const hook = await mountHook(() => useSignOut());

    await act(async () => {
      await hook().requestSignOut();
    });

    // Unknown flags + offline → no dead-end warning; clear locally instead.
    await waitFor(() => expect(mockSessionState.logout).toHaveBeenCalled());
    expect(hook().confirmVisible).toBe(false);
  });
});
