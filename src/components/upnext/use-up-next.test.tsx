import { act, renderHook } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { QueueEntry } from '@/api/types';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

let mockQueue: QueueEntry[] | undefined;
const mockAdd = jest.fn();
const mockRemove = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError, itemQuery, chaptersQuery } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    itemQuery,
    chaptersQuery,
    useCapability: () => true,
    useQueue: () => ({ data: mockQueue, isLoading: false, error: null, refetch: jest.fn() }),
    useAddToQueue: () => ({ mutateAsync: mockAdd, isPending: false }),
    useRemoveFromQueue: () => ({ mutateAsync: mockRemove, isPending: false }),
    useNextBook: () => ({ data: undefined }),
    useAllProgressAll: () => ({ progress: [] }),
  };
});
const mockItem = jest.fn();
const mockChapters = jest.fn();
jest.mock('@/api/provider', () =>
  // `require` (not an import) because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    c: {
      item: (...a: unknown[]) => mockItem(...a),
      chapters: (...a: unknown[]) => mockChapters(...a),
    },
  }),
);
// The start resolves the book's client by its connection id (`startBookInPlace`): the
// same fake clients.
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (id: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/api/provider').useApiRegistry().clients.get(id) ?? null,
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
const mockPlayBook = jest.fn();
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    selectBookKey: () => null,
    selectIsTransportLive: () => false,
    usePlayer: create(() => ({
      nowPlaying: null,
      snapshot: { state: 'paused' },
      playBook: (...a: unknown[]) => mockPlayBook(...a),
      toggle: jest.fn(),
    })),
  };
});

/* eslint-disable import/first */
import { CapabilityError } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { useSession } from '@/stores/session';

import { useUpNext } from './up-next-store';
import { usePlayNow, useUpNextConnection, useUpNextData } from './use-up-next';
/* eslint-enable import/first */

const entry = (path: string): QueueEntry => ({
  library_id: 1,
  path,
  added_at: '2026-10-06T10:00:00Z',
});
const lastToast = () => mockToast.mock.calls.at(-1)?.[0];

beforeEach(() => {
  queryClient.clear();
  mockQueue = [entry('A'), entry('B'), entry('C')];
  mockAdd.mockReset().mockResolvedValue([]);
  mockRemove.mockReset().mockResolvedValue(undefined);
  mockToast.mockReset();
  mockPush.mockReset();
  mockPlayBook.mockReset().mockResolvedValue(undefined);
  mockItem.mockReset().mockResolvedValue({ rel_path: 'B' });
  mockChapters.mockReset().mockResolvedValue({ files: [] });
  mockLayout = 'desktop';
});

describe('useUpNextConnection', () => {
  it('shows the default server when nothing is loaded', async () => {
    useSession.setState({
      connections: [{ id: 'a' }, { id: 'b' }] as never,
      defaultConnectionId: 'b',
    });
    const { result } = await renderHook(() => useUpNextConnection());
    expect(result.current).toBe('b');
  });
});

describe('useUpNextData', () => {
  const hook = async () => (await renderHook(() => useUpNextData('c'))).result;

  it('moves one entry with a positioned add, never a whole-list replace', async () => {
    const r = await hook();
    let ok = false;
    await act(async () => {
      ok = await r.current.move(entry('C'), 0);
    });
    expect(ok).toBe(true);
    expect(mockAdd).toHaveBeenCalledWith({ libraryId: 1, path: 'C', position: 0 });
  });

  it('says a move failed, but stays quiet on a CapabilityError', async () => {
    const r = await hook();
    mockAdd.mockRejectedValueOnce(new ApiError(500, 'boom'));
    await act(async () => {
      expect(await r.current.move(entry('A'), 2)).toBe(false);
    });
    expect(lastToast().title).toBe("Couldn't update Up next. Try again.");
    mockToast.mockReset();
    mockAdd.mockRejectedValueOnce(new CapabilityError('queue'));
    await act(async () => {
      await r.current.move(entry('A'), 2);
    });
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('clears the visible entries one exact path at a time, and Undo puts them back in order', async () => {
    const r = await hook();
    await act(async () => {
      await r.current.clear(mockQueue!);
    });
    expect(mockRemove.mock.calls.map((c) => c[0])).toEqual([
      { libraryId: 1, path: 'A' },
      { libraryId: 1, path: 'B' },
      { libraryId: 1, path: 'C' },
    ]);
    expect(lastToast().title).toBe('Up next cleared');
    await act(async () => {
      lastToast().action.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockAdd.mock.calls.map((c) => c[0])).toEqual([
      { libraryId: 1, path: 'A', position: 0 },
      { libraryId: 1, path: 'B', position: 1 },
      { libraryId: 1, path: 'C', position: 2 },
    ]);
  });

  it('stops clearing at the first failure and offers back only what it took off', async () => {
    mockRemove.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError(500, 'x'));
    const r = await hook();
    await act(async () => {
      await r.current.clear(mockQueue!);
    });
    expect(mockRemove).toHaveBeenCalledTimes(2);
    const undo = mockToast.mock.calls.map((c) => c[0]).find((o) => o.action);
    await act(async () => {
      undo.action.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockAdd.mock.calls.map((c) => c[0])).toEqual([{ libraryId: 1, path: 'A', position: 0 }]);
  });
});

describe('usePlayNow', () => {
  it('starts the book under the dock on a desktop, then takes it off the queue', async () => {
    const drop = jest.fn();
    const { result } = await renderHook(() => usePlayNow('c', drop));
    await act(async () => {
      await result.current(entry('B'), 'Book B');
    });
    expect(mockItem).toHaveBeenCalledWith(1, 'B', expect.anything());
    expect(mockPlayBook).toHaveBeenCalledWith('c', 1, { rel_path: 'B' }, { files: [] }, undefined);
    expect(drop).toHaveBeenCalledWith(entry('B'));
  });

  it('opens the full player on a phone, closing the sheet first', async () => {
    mockLayout = 'phone';
    useUpNext.setState({ sheetOpen: true });
    const drop = jest.fn();
    const { result } = await renderHook(() => usePlayNow('c', drop));
    await act(async () => {
      await result.current(entry('B'), 'Book B');
    });
    expect(useUpNext.getState().sheetOpen).toBe(false);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/player',
      params: { connection: 'c', libraryId: '1', path: 'B' },
    });
    expect(mockPlayBook).not.toHaveBeenCalled();
    expect(drop).toHaveBeenCalled();
  });

  it('keeps the entry and says so when the book cannot start', async () => {
    mockItem.mockRejectedValueOnce(new Error('offline'));
    const drop = jest.fn();
    const { result } = await renderHook(() => usePlayNow('c', drop));
    await act(async () => {
      await result.current(entry('B'), 'Book B');
    });
    expect(drop).not.toHaveBeenCalled();
    expect(lastToast().title).toBe("Couldn't start Book B. Try again.");
  });
});
