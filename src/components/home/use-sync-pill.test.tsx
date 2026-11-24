import { act, renderHook } from '@testing-library/react-native';

let mockWaiting = { saves: 0, listens: 0 };
const mockQueueListeners = new Set<() => void>();
jest.mock('@/playback/progress-sync', () => ({
  pendingSaves: async () => mockWaiting,
  onQueueChange: (fn: () => void) => {
    mockQueueListeners.add(fn);
    return () => mockQueueListeners.delete(fn);
  },
}));
jest.mock('@/playback/listening-outbox', () => ({
  onOutboxChange: () => () => undefined,
  outboxEvents: async () => [],
  syncStateOf: async () => ({ failed: [] }),
}));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { queryClient as qc } from '@/api/provider';
import { useReachability } from '@/api/reachability';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

import { usePendingCounts, useSyncPill } from './use-sync-pill';
/* eslint-enable import/first */

notifyQueriesSynchronously();

// UPGRADE-05: the pill says when this device last read the progress, not when the newest
// save was made (another device's, 24 minutes before this one signed in).
describe('useSyncPill', () => {
  const newest = { at: '2026-10-05T10:00:00Z', connectionId: 'a' };
  // The app's client: what a test wrote goes, whether it passed or not.
  afterEach(() => qc.clear());

  it('follows the progress list this device last read from the server', async () => {
    useReachability.setState({ online: {} });
    const { result, unmount } = await renderHook(() => useSyncPill(newest));
    // Not read yet: the newest save's time.
    expect(result.current).toEqual({ kind: 'synced', at: newest.at });

    const readAt = Date.parse('2026-10-05T10:24:00Z');
    await act(async () => {
      qc.setQueryData(qk.allProgress('a'), [], { updatedAt: readAt });
    });
    expect(result.current).toEqual({ kind: 'synced', at: '2026-10-05T10:24:00.000Z' });

    // Another connection's read says nothing about this one.
    await act(async () => {
      qc.setQueryData(qk.allProgress('b'), [], { updatedAt: readAt + 60_000 });
    });
    expect(result.current).toEqual({ kind: 'synced', at: '2026-10-05T10:24:00.000Z' });
    await unmount();
  });
});

// fe#197: a reconnect replays the queue; the pill goes as it drains, not 20 s later.
describe('usePendingCounts', () => {
  it('reads the counts again when the offline queue changes', async () => {
    useReachability.setState({ online: {} });
    mockWaiting = { saves: 2, listens: 0 };
    const { result, unmount } = await renderHook(() => usePendingCounts());
    expect(result.current).toEqual({ saves: 2, listens: 0 });
    mockWaiting = { saves: 0, listens: 0 };
    await act(async () => {
      for (const fn of mockQueueListeners) fn();
    });
    expect(result.current).toEqual({ saves: 0, listens: 0 });
    await unmount();
    expect(mockQueueListeners.size).toBe(0);
  });
});
