import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('@/playback/progress-sync', () => ({
  pendingSaves: async () => ({ saves: 0, listens: 0 }),
}));
jest.mock('@/playback/listening-outbox', () => ({
  onOutboxChange: () => () => undefined,
  outboxEvents: async () => [],
  syncStateOf: async () => ({ failed: [] }),
}));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { useReachability } from '@/api/reachability';

import { useSyncPill } from './use-sync-pill';
/* eslint-enable import/first */

// UPGRADE-05: the pill says when this device last read the progress, not when the newest
// save was made (another device's, 24 minutes before this one signed in).
describe('useSyncPill', () => {
  const newest = { at: '2026-10-05T10:00:00Z', connectionId: 'a' };

  it('follows the progress list this device last read from the server', async () => {
    useReachability.setState({ online: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = await renderHook(() => useSyncPill(newest), { wrapper });
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
  });
});
