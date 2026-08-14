import { ApiError, TimeoutError, type ApiClient } from '@/api/client';
import type { Progress } from '@/api/types';

// The fetch helper is deliberately framework-free, so the two collaborators it can reach
// (the reachability layer and the durable progress mirror) are mocked and asserted on.
const mockNoteError = jest.fn();
jest.mock('@/api/reachability', () => ({
  noteError: (...args: unknown[]) => mockNoteError(...args),
}));

const mockMirroredProgress = jest.fn(async (..._args: unknown[]): Promise<Progress | null> => null);
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: (...args: unknown[]) => mockMirroredProgress(...args),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

// The provider is React-Query/session-bound; hooks.ts only needs it at hook call time,
// and this suite exercises the pure helper.
jest.mock('@/api/provider', () => ({
  queryClient: { invalidateQueries: jest.fn(), setQueryData: jest.fn() },
  useApi: jest.fn(),
  useApis: jest.fn(),
  useCid: jest.fn(),
  useOptionalApi: jest.fn(),
}));

/* eslint-disable import/first */
import { fetchBookProgress } from '@/api/hooks';
/* eslint-enable import/first */

function makeProgress(): Progress {
  return {
    library_id: 2,
    path: 'A/Book.m4b',
    position: 42,
    duration: 100,
    finished: false,
    playback_speed: 1,
    version: 0,
    device_id: 'dev',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** An `ApiClient` stub whose only used method is `getProgress`. */
function clientThat(impl: () => Promise<Progress | null>): ApiClient {
  return { getProgress: jest.fn(impl) } as unknown as ApiClient;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMirroredProgress.mockResolvedValue(null);
});

describe('fetchBookProgress', () => {
  it('returns the server value on success', async () => {
    const p = makeProgress();
    const api = clientThat(async () => p);

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).resolves.toBe(p);
    expect(mockMirroredProgress).not.toHaveBeenCalled();
    expect(mockNoteError).not.toHaveBeenCalled();
  });

  // The reconnect invariant: a 401 has already flagged the connection via the client's
  // onAuthError, so resolving it as a query SUCCESS would let provider.tsx's
  // QueryCache.onSuccess clear the banner the same request just raised.
  it('rethrows a 401 ApiError instead of falling back to the mirror', async () => {
    const err = new ApiError(401, 'unauthorized');
    const api = clientThat(async () => {
      throw err;
    });

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).rejects.toBe(err);
    expect(mockMirroredProgress).not.toHaveBeenCalled();
    expect(mockNoteError).not.toHaveBeenCalled();
  });

  it('rethrows a 403 ApiError (a real answer, not an unreachable server)', async () => {
    const err = new ApiError(403, 'forbidden');
    const api = clientThat(async () => {
      throw err;
    });

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).rejects.toBe(err);
    expect(mockMirroredProgress).not.toHaveBeenCalled();
  });

  it('falls back to the mirror and notes reachability on a network failure', async () => {
    const mirrored = makeProgress();
    mockMirroredProgress.mockResolvedValue(mirrored);
    const err = new Error('Network request failed');
    const api = clientThat(async () => {
      throw err;
    });

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).resolves.toBe(mirrored);
    expect(mockMirroredProgress).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b');
    expect(mockNoteError).toHaveBeenCalledWith('c1', err);
  });

  it('falls back to the mirror on a TimeoutError too', async () => {
    const err = new TimeoutError(1000);
    const api = clientThat(async () => {
      throw err;
    });

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).resolves.toBeNull();
    expect(mockNoteError).toHaveBeenCalledWith('c1', err);
  });

  it('rethrows on an aborted signal without touching the mirror', async () => {
    const controller = new AbortController();
    const err = new Error('Aborted');
    const api = clientThat(async () => {
      controller.abort();
      throw err;
    });

    await expect(fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', controller.signal)).rejects.toBe(
      err,
    );
    expect(mockMirroredProgress).not.toHaveBeenCalled();
    expect(mockNoteError).not.toHaveBeenCalled();
  });
});
