import { act, render, waitFor } from '@testing-library/react-native';

import type { User } from '@/api/types';

const mockApi = { logout: jest.fn(), me: jest.fn() };
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));

// The session store is driven directly here: the mock runs the selector against a
// controlled state object. useSignOut(connectionId) reads the connection's user from
// the `connections` list and targets it for teardown/removal, so each test seeds a
// connection carrying the user + spies on removeConnection/setConnectionUser.
let mockSessionState: {
  connections: { id: string; user: User | null }[];
  setConnectionUser: jest.Mock;
  removeConnection: jest.Mock;
};
jest.mock('@/stores/session', () => ({
  useSession: (selector: (s: unknown) => unknown) => selector(mockSessionState),
}));

// signOut runs the shared token-revoking teardown (playback stop + queued-progress
// flush); mock the player store so this test (focused on the recovery-warning
// decision) doesn't pull in the native engine.
jest.mock('@/playback/store', () => ({ teardownBeforeTokenRevoke: jest.fn(async () => {}) }));

/* eslint-disable import/first */
import { teardownBeforeTokenRevoke } from '@/playback/store';

import { useSignOut } from './use-sign-out';
/* eslint-enable import/first */

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

// Seed connection 'c1' carrying `u` as its user (what the hook reads for the decision).
const seed = (u: User | null) => {
  mockSessionState = {
    connections: [{ id: 'c1', user: u }],
    setConnectionUser: jest.fn(),
    removeConnection: jest.fn().mockResolvedValue(undefined),
  };
};

beforeEach(() => {
  mockApi.logout.mockReset().mockResolvedValue(undefined);
  mockApi.me.mockReset();
  seed(null);
});

describe('useSignOut', () => {
  it('warns instead of signing out when the account would be stranded', async () => {
    seed(user({ has_password: false, has_recovery: false }));
    const hook = await mountHook(() => useSignOut('c1'));

    await act(async () => {
      await hook().requestSignOut();
    });

    expect(hook().confirmVisible).toBe(true);
    expect(mockSessionState.removeConnection).not.toHaveBeenCalled();
  });

  it('signs out directly when the user still has a credential', async () => {
    seed(user({ has_password: true }));
    const hook = await mountHook(() => useSignOut('c1'));

    await act(async () => {
      await hook().requestSignOut();
    });

    // Removes this connection specifically (not whatever is "active").
    await waitFor(() => expect(mockSessionState.removeConnection).toHaveBeenCalledWith('c1'));
    expect(hook().confirmVisible).toBe(false);
    // Before revoking the token: the shared teardown (stop playback + flush the
    // queued progress that removing the connection would purge).
    expect(teardownBeforeTokenRevoke).toHaveBeenCalledWith('c1');
  });

  it('refreshes unknown flags from /me before deciding (and warns when stranded)', async () => {
    seed(flaglessUser);
    mockApi.me.mockResolvedValue(user({ has_password: false, has_recovery: false }));
    const hook = await mountHook(() => useSignOut('c1'));

    await act(async () => {
      await hook().requestSignOut();
    });

    expect(mockApi.me).toHaveBeenCalled();
    expect(mockSessionState.setConnectionUser).toHaveBeenCalledWith('c1', expect.anything());
    expect(hook().confirmVisible).toBe(true);
  });

  it('falls back to signing out (no warning) when /me is unreachable', async () => {
    seed(flaglessUser);
    mockApi.me.mockRejectedValue(new Error('offline'));
    const hook = await mountHook(() => useSignOut('c1'));

    await act(async () => {
      await hook().requestSignOut();
    });

    // Unknown flags + offline → no dead-end warning; clear locally instead.
    await waitFor(() => expect(mockSessionState.removeConnection).toHaveBeenCalledWith('c1'));
    expect(hook().confirmVisible).toBe(false);
  });
});
