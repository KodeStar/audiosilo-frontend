import { act, render, waitFor } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { ApiKey } from '@/api/types';

// The manager composes the connection-scoped React Query hooks; mock them so the test
// drives pure orchestration (label input, one-time reveal, revoke confirmation) without
// a QueryClient. useCreateApiKey exposes mutateAsync (awaited) + isPending; useRevokeApiKey
// exposes mutate (fire-and-forget).
const mockList: { data: ApiKey[]; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};
const mockCreate = { mutateAsync: jest.fn(), isPending: false };
const mockRevoke = { mutate: jest.fn() };
jest.mock('@/api/hooks', () => ({
  useApiKeys: () => mockList,
  useCreateApiKey: () => mockCreate,
  useRevokeApiKey: () => mockRevoke,
}));

// eslint-disable-next-line import/first
import { useApiKeysManager } from './use-api-keys-manager';

// renderHook is incompatible with this jest-expo + React 19 setup, so mount a probe
// component that re-captures the hook value on every render (see use-sign-out.test).
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

const madeKey = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: 1,
  label: 'Dashboard',
  created_at: '2026-07-09T10:00:00Z',
  last_seen: null,
  ...over,
});

beforeEach(() => {
  mockList.data = [];
  mockList.isLoading = false;
  mockList.isError = false;
  mockCreate.mutateAsync.mockReset();
  mockCreate.isPending = false;
  mockRevoke.mutate.mockReset();
});

describe('useApiKeysManager', () => {
  it('does not create when the label is blank (server would 400)', async () => {
    const hook = await mountHook(() => useApiKeysManager('c1', true));
    expect(hook().canCreate).toBe(false);

    await act(async () => {
      hook().setLabel('   ');
    });
    expect(hook().canCreate).toBe(false);
    await act(async () => {
      await hook().create();
    });
    expect(mockCreate.mutateAsync).not.toHaveBeenCalled();
    expect(hook().created).toBeNull();
  });

  it('creates a key, reveals the one-time secret, and clears the input', async () => {
    mockCreate.mutateAsync.mockResolvedValue({ token: 'sk_secret', api_key: madeKey() });
    const hook = await mountHook(() => useApiKeysManager('c1', true));

    await act(async () => {
      hook().setLabel('  Dashboard  ');
    });
    expect(hook().canCreate).toBe(true);
    await act(async () => {
      await hook().create();
    });

    // Label is trimmed before sending.
    expect(mockCreate.mutateAsync).toHaveBeenCalledWith('Dashboard');
    await waitFor(() => expect(hook().created?.token).toBe('sk_secret'));
    expect(hook().label).toBe('');

    await act(async () => {
      hook().dismissCreated();
    });
    expect(hook().created).toBeNull();
  });

  it('surfaces the server error and reveals no secret when creation fails', async () => {
    mockCreate.mutateAsync.mockRejectedValue(new ApiError(403, 'demo accounts cannot mint keys'));
    const hook = await mountHook(() => useApiKeysManager('c1', true));

    await act(async () => {
      hook().setLabel('Key');
    });
    await act(async () => {
      await hook().create();
    });

    expect(hook().createError).toBe('demo accounts cannot mint keys');
    expect(hook().created).toBeNull();
  });

  it('confirms before revoking, then revokes by id and clears the pending key', async () => {
    mockList.data = [madeKey({ id: 42, label: 'Cron' })];
    const hook = await mountHook(() => useApiKeysManager('c1', true));

    await act(async () => {
      hook().requestRevoke(mockList.data[0]);
    });
    expect(hook().pendingRevoke?.id).toBe(42);
    expect(mockRevoke.mutate).not.toHaveBeenCalled();

    await act(async () => {
      hook().confirmRevoke();
    });
    expect(mockRevoke.mutate).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    expect(hook().pendingRevoke).toBeNull();
  });

  it('cancels a pending revoke without calling the mutation', async () => {
    mockList.data = [madeKey({ id: 42 })];
    const hook = await mountHook(() => useApiKeysManager('c1', true));

    await act(async () => {
      hook().requestRevoke(mockList.data[0]);
    });
    await act(async () => {
      hook().cancelRevoke();
    });
    expect(hook().pendingRevoke).toBeNull();
    expect(mockRevoke.mutate).not.toHaveBeenCalled();
  });

  it('does not create again while a create is in flight (guards the keyboard-submit path)', async () => {
    // The Create button is disabled while pending, but onSubmitEditing bypasses that;
    // create() must guard on isPending itself so a second Return can't mint a duplicate.
    mockCreate.isPending = true;
    const hook = await mountHook(() => useApiKeysManager('c1', true));

    await act(async () => {
      hook().setLabel('Dashboard');
    });
    expect(hook().canCreate).toBe(false);
    await act(async () => {
      await hook().create();
    });
    expect(mockCreate.mutateAsync).not.toHaveBeenCalled();
  });

  it('surfaces a revoke failure so a still-live key is not silently believed dead', async () => {
    mockList.data = [madeKey({ id: 7 })];
    mockRevoke.mutate.mockImplementation(
      (_id: number, opts?: { onError?: (e: unknown) => void }) => {
        opts?.onError?.(new ApiError(500, 'server exploded'));
      },
    );
    const hook = await mountHook(() => useApiKeysManager('c1', true));

    await act(async () => {
      hook().requestRevoke(mockList.data[0]);
    });
    await act(async () => {
      hook().confirmRevoke();
    });
    expect(hook().revokeError).toBe('server exploded');
  });

  it('clears a stale create error when the name is edited', async () => {
    mockCreate.mutateAsync.mockRejectedValue(new ApiError(400, 'label too long'));
    const hook = await mountHook(() => useApiKeysManager('c1', true));

    await act(async () => {
      hook().setLabel('waytoolonglabelthatis');
    });
    await act(async () => {
      await hook().create();
    });
    expect(hook().createError).toBe('label too long');

    await act(async () => {
      hook().setLabel('shorter');
    });
    expect(hook().createError).toBeNull();
  });
});
