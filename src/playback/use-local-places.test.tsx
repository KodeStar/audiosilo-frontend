import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook, waitFor } from '@testing-library/react-native';

import type { Progress } from '@/api/types';

jest.mock('@/api/reachability', () => ({
  isReachable: jest.fn(() => true),
  noteFailure: jest.fn(),
  noteSuccess: jest.fn(),
}));
jest.mock('@/api/connection-clients', () => ({
  resolveClient: jest.fn(() => null),
  sessionReady: jest.fn(() => true),
}));
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
  useSession: jest.fn(),
}));
const mockOutboxListeners = new Set<() => void>();
jest.mock('./listening-outbox', () => ({
  onOutboxChange: (l: () => void) => {
    mockOutboxListeners.add(l);
    return () => mockOutboxListeners.delete(l);
  },
}));

/* eslint-disable import/first */
import { writeMirror } from './progress-sync';
import { useWithLocalPlaces } from './use-local-places';
/* eslint-enable import/first */

const row = (position: number, updated_at: string) => ({
  library_id: 1,
  path: 'A/Book',
  position,
  duration: 100,
  finished: false,
  playback_speed: 1,
  version: 3,
  device_id: 'tablet',
  updated_at,
  connectionId: 'c1',
  connectionName: 'Home',
});

const mirror = (position: number, updated_at: string) =>
  writeMirror({
    connectionId: 'c1',
    libraryId: 1,
    path: 'A/Book',
    position,
    duration: 100,
    finished: false,
    playback_speed: 1,
    device_id: 'me',
    updated_at,
  });

beforeEach(async () => {
  await AsyncStorage.clear();
  mockOutboxListeners.clear();
});

// fe#211: after an offline run Home said 0% while the player said 3%: the list's row is
// the server's, the player's is this device's newer one.
it("shows this device's newer place over the list's row, read again as the outbox changes", async () => {
  await mirror(3, '2026-03-02T00:00:00Z');
  const rows: (Progress & { connectionId: string; connectionName: string })[] = [
    row(0, '2026-03-01T00:00:00Z'),
  ];
  const { result } = await renderHook(() => useWithLocalPlaces(rows));
  await waitFor(() => expect(result.current[0].position).toBe(3));
  expect(result.current[0].connectionName).toBe('Home');

  // A listen closed (or synced): the places are read again.
  await mirror(9, '2026-03-03T00:00:00Z');
  mockOutboxListeners.forEach((l) => l());
  await waitFor(() => expect(result.current[0].position).toBe(9));
});

it('keeps the list as it came while nothing local is newer', async () => {
  const rows = [row(40, '2026-03-05T00:00:00Z')];
  const { result } = await renderHook(() => useWithLocalPlaces(rows));
  await waitFor(() => expect(result.current).toBe(rows));
});
