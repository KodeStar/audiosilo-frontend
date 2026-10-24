import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiClient, ApiError, TimeoutError } from '@/api/client';
import { isReachable, useReachability } from '@/api/reachability';
import { pendingSaveCount, type ProgressSave, saveProgress } from '@/playback/progress-sync';

// FU-NOTEERR: a progress save that got no answer only asks for a check of its server,
// against the real reachability module; only the check marks the server down.
const mockServerInfo = jest.fn();
jest.mock('@/api/connection-clients', () => ({
  // Both the check (`/server`) and the queue replay resolve the connection's client here.
  resolveClient: () => ({ baseUrl: 'https://h', serverInfo: mockServerInfo }),
  sessionReady: () => true,
}));
jest.mock('@/stores/session', () => ({ onConnectionRemoved: () => () => {} }));

const save: ProgressSave = {
  connectionId: 'c1',
  libraryId: 1,
  path: 'A/Book',
  position: 10,
  duration: 100,
  finished: false,
  playback_speed: 1,
  device_id: 'dev',
  updated_at: '2026-01-01T00:00:00Z',
};

const failingApi = (e: Error) =>
  ({ saveProgress: jest.fn(() => Promise.reject(e)) }) as unknown as ApiClient;

beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  mockServerInfo.mockReset();
  useReachability.setState({ online: {} });
});
afterEach(() => {
  useReachability.setState({ online: {} });
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a progress save that fails', () => {
  it('leaves its server reachable after a timeout, queues the save and asks for a check', async () => {
    mockServerInfo.mockResolvedValue({});
    await saveProgress(failingApi(new TimeoutError(15_000)), save);
    expect(mockServerInfo).toHaveBeenCalledTimes(1);
    expect(isReachable('c1')).toBe(true);
    expect(await pendingSaveCount('c1')).toBe(1);
  });

  it('marks its server down only when the check gets no answer either', async () => {
    mockServerInfo.mockRejectedValue(new TypeError('Network request failed'));
    await saveProgress(failingApi(new TypeError('Network request failed')), save);
    await jest.advanceTimersByTimeAsync(0);
    expect(isReachable('c1')).toBe(false);
    expect(await pendingSaveCount('c1')).toBe(1);
  });

  it('takes a 5xx as an answer: reachable, queued, no check', async () => {
    await saveProgress(failingApi(new ApiError(503, 'unavailable')), save);
    expect(mockServerInfo).not.toHaveBeenCalled();
    expect(isReachable('c1')).toBe(true);
    expect(await pendingSaveCount('c1')).toBe(1);
  });
});
