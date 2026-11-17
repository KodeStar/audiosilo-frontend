import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

// The screen's focus, run by hand: the hook runs its callback on every focus.
let mockFocus: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => {
    mockFocus = cb;
  },
}));

/* eslint-disable import/first */
import { useUpcomingClock } from './use-upcoming-clock';
/* eslint-enable import/first */

// fe#204: a Home left open past a release day kept its "Out <date>" and its badges.
describe('useUpcomingClock', () => {
  const T0 = new Date('2026-11-12T08:00:00Z');
  let appState: ((state: string) => void) | null = null;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
      appState = fn as (state: string) => void;
      return { remove: () => (appState = null) } as never;
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const refetch = jest.spyOn(qc, 'refetchQueries').mockResolvedValue();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const hook = await renderHook(() => useUpcomingClock(), { wrapper });
    return { ...hook, refetch };
  }

  it('reads the clock again on focus and on coming to the front, the stale lists on focus', async () => {
    const { result, refetch, unmount } = await mount();
    expect(result.current).toEqual(T0);
    const later = new Date('2026-11-13T09:00:00Z');
    jest.setSystemTime(later);
    // Steady while it stays in view.
    expect(result.current).toEqual(T0);
    await act(async () => mockFocus?.());
    expect(result.current).toEqual(later);
    expect(refetch).toHaveBeenLastCalledWith(
      { queryKey: ['upcoming'], type: 'active', stale: true },
      { cancelRefetch: false },
    );
    const calls = refetch.mock.calls.length;
    const next = new Date('2026-11-14T09:00:00Z');
    jest.setSystemTime(next);
    await act(async () => appState?.('background'));
    expect(refetch).toHaveBeenCalledTimes(calls);
    await act(async () => appState?.('active'));
    expect(result.current).toEqual(next);
    // The app's resume refresh reads every active query then, so nothing more here.
    expect(refetch).toHaveBeenCalledTimes(calls);
    await unmount();
    expect(appState).toBeNull();
  });
});
