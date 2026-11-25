import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { setConnectionAliases } from '@/lib/connection-id';
import { LISTENING_OUTBOX_KEY, PROGRESS_MIRROR_KEY, PROGRESS_QUEUE_KEY } from '@/lib/storage-keys';
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
import { refreshLocalPlaces, usePendingFinish, useWithLocalPlaces } from './use-local-places';
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

it('shares one storage read per burst and keeps unchanged rows across notifications', async () => {
  jest.useFakeTimers();
  try {
    const rows = [row(40, '2026-03-05T00:00:00Z')];
    const rendered = jest.fn();
    const mounted = () =>
      renderHook(() => {
        rendered();
        return useWithLocalPlaces(rows);
      });
    await mounted();
    await mounted();
    await act(async () => jest.advanceTimersByTimeAsync(100));
    expect(mockOutboxListeners.size).toBe(1);
    const get = jest.mocked(AsyncStorage.getItem);
    get.mockClear();
    rendered.mockClear();
    for (let i = 0; i < 5; i++) mockOutboxListeners.forEach((l) => l());
    await act(async () => jest.advanceTimersByTimeAsync(100));
    expect(get.mock.calls.filter(([key]) => key === PROGRESS_MIRROR_KEY)).toHaveLength(1);
    expect(rendered).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it.each(['event', 'PUT'])(
  'shows a waiting %s finish for an unlisted book of the visible connection, then removes it on Undo',
  async (route) => {
    const save = {
      connectionId: 'c1',
      libraryId: 1,
      path: 'A/New',
      position: 100,
      duration: 100,
      finished: true,
      playback_speed: 1,
      device_id: 'here',
      updated_at: '2026-04-01T00:00:00Z',
    };
    const other = { ...save, connectionId: 'c2' };
    await writeMirror(save);
    await writeMirror(other);
    const waitKey = route === 'event' ? LISTENING_OUTBOX_KEY : PROGRESS_QUEUE_KEY;
    const waiting =
      route === 'event'
        ? [save, other].map((s) => ({
            connectionId: s.connectionId,
            event: { kind: 'finish', library_id: s.libraryId, path: s.path },
          }))
        : [save, other];
    await AsyncStorage.setItem(waitKey, JSON.stringify(waiting));
    const rows: ReturnType<typeof row>[] = [];
    const sources = [{ id: 'c1', name: 'Home' }];
    const { result } = await renderHook(() => ({
      list: useWithLocalPlaces(rows, sources),
      tile: usePendingFinish('c1', 1, 'A/New', true),
      disabled: usePendingFinish('c2', 1, 'A/New', false),
    }));
    await waitFor(() => expect(result.current.list).toHaveLength(1));
    expect(result.current.list[0]).toMatchObject({
      finished: true,
      connectionName: 'Home',
      path: 'A/New',
    });
    expect(result.current.tile).toMatchObject({ finished: true, position: 100 });
    expect(result.current.disabled).toBeUndefined();
    // Undo has taken it back. An old finished mirror alone must never introduce a list row.
    await AsyncStorage.setItem(waitKey, '[]');
    refreshLocalPlaces();
    await waitFor(() => expect(result.current.list).toEqual([]));
    expect(result.current.tile).toBeUndefined();
  },
);

it('shows an old-id finish only for the account it moved to', async () => {
  setConnectionAliases({ legacy: 'legacy.7' });
  const save = {
    connectionId: 'legacy',
    libraryId: 1,
    path: 'A/New',
    position: 100,
    duration: 100,
    finished: true,
    playback_speed: 1,
    device_id: 'me',
    updated_at: '2026-04-01T00:00:00Z',
  };
  try {
    await writeMirror(save);
    await AsyncStorage.setItem(
      LISTENING_OUTBOX_KEY,
      JSON.stringify([
        { connectionId: 'legacy', event: { kind: 'finish', library_id: 1, path: save.path } },
      ]),
    );
    const rows: ReturnType<typeof row>[] = [];
    const sources = [
      { id: 'legacy.7', name: 'Home' },
      { id: 'legacy.8', name: 'Sibling' },
    ];
    const { result } = await renderHook(() => ({
      list: useWithLocalPlaces(rows, sources),
      own: usePendingFinish('legacy.7', 1, save.path, true),
      sibling: usePendingFinish('legacy.8', 1, save.path, true),
    }));
    await waitFor(() => expect(result.current.list).toHaveLength(1));
    expect(result.current.list[0].connectionId).toBe('legacy.7');
    expect(result.current.own?.finished).toBe(true);
    expect(result.current.sibling).toBeUndefined();
  } finally {
    setConnectionAliases({});
  }
});
