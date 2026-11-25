import { act, renderHook } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { QueueEntry } from '@/api/types';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

let mockQueue: QueueEntry[] | undefined;
let mockProgress: object[] = [];
const mockAdd = jest.fn();
const mockRemove = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError, itemQuery, chaptersQuery, fetchFailFast } =
    jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    itemQuery,
    chaptersQuery,
    fetchFailFast,
    useCapability: () => true,
    useQueue: () => ({ data: mockQueue, isLoading: false, error: null, refetch: jest.fn() }),
    useAddToQueue: () => ({ mutateAsync: mockAdd, isPending: false }),
    useRemoveFromQueue: () => ({ mutateAsync: mockRemove, isPending: false }),
    useNextBook: () => ({ data: undefined }),
    useAllProgressAll: () => ({ progress: mockProgress }),
  };
});
const mockItem = jest.fn();
const mockChapters = jest.fn();
const mockDrop = jest.fn();
jest.mock('@/components/player/drop-started', () => ({
  dropStartedBook: (...a: unknown[]) => mockDrop(...a),
}));
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
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  // No full player on top (`usePlayerOnTop`, which `usePlayBook` reads).
  useSegments: () => [],
  // The page under the panel (`useShownBook`).
  usePathname: () => mockRoute.pathname,
  useGlobalSearchParams: () => mockRoute.params,
}));
let mockRoute: { pathname: string; params: Record<string, string> } = { pathname: '/', params: {} };
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
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { usePlayerSheets } from '@/components/player/player-sheets';
import { usePlayNow, useUpNextConnection, useUpNextData } from './use-up-next';
/* eslint-enable import/first */

const entry = (path: string): QueueEntry => ({
  library_id: 1,
  path,
  added_at: '2026-10-06T10:00:00Z',
});
const lastToast = () => mockToast.mock.calls.at(-1)?.[0];

beforeEach(() => {
  resetProfilesForTests();
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
  mockProgress = [];
  mockRoute = { pathname: '/', params: {} };
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

  it("never shows another person's queue: the default is someone else's, so the listener's first", async () => {
    useSession.setState({
      connections: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never,
      defaultConnectionId: 'a',
    });
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'chris', name: 'Chris', connectionIds: ['a'] },
        { id: 'sam', name: 'Sam', connectionIds: ['b', 'c'] },
      ],
      activeProfileId: 'sam',
    });
    const { result } = await renderHook(() => useUpNextConnection());
    expect(result.current).toBe('b');
  });
});

describe('useUpNextData', () => {
  const hook = async () => (await renderHook(() => useUpNextData('c'))).result;

  // fe#197 FE196-UPNEXT: Up next over a book's own page never offers that book.
  it("never suggests the book whose page is on screen, on this server's page only", async () => {
    useSession.setState({ connections: [{ id: 'c' }, { id: 'd' }] as never });
    const prog = (path: string) => ({
      connectionId: 'c',
      library_id: 1,
      path,
      position: 10,
      duration: 100,
      finished: false,
    });
    mockProgress = [prog('Shown'), prog('Other')];
    const paths = async () =>
      (await hook()).current.suggestions.map((s) => ('ref' in s ? s.ref.path : s.title));
    mockRoute = { pathname: '/book/1', params: { libraryId: '1', path: 'Shown', connection: 'c' } };
    expect(await paths()).toEqual(['Other']);
    // A part path of it (a disc folder) is the same book.
    mockRoute.params.path = 'Shown/Disc 1';
    expect(await paths()).toEqual(['Other']);
    // Another server's page, or no book page, leaves it in.
    mockRoute.params.connection = 'd';
    expect(await paths()).toEqual(['Shown', 'Other']);
    mockRoute = { pathname: '/library', params: { libraryId: '1', path: 'Shown' } };
    expect(await paths()).toEqual(['Shown', 'Other']);
  });

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
  beforeEach(() => mockDrop.mockReset());

  it('starts the book under the dock on a desktop, then takes it off the queue', async () => {
    const { result } = await renderHook(() => usePlayNow('c'));
    await act(async () => {
      await result.current(entry('B'), 'Book B');
    });
    expect(mockItem).toHaveBeenCalledWith(1, 'B', expect.anything());
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c',
      1,
      { rel_path: 'B' },
      { files: [] },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Number),
    );
    expect(mockDrop).toHaveBeenCalledWith('c', 1, undefined, 'B');
  });

  it('passes the resolved book path when the queue entry names its own book', async () => {
    mockLayout = 'phone';
    const { result } = await renderHook(() => usePlayNow('c'));
    await act(async () => {
      await result.current(
        { ...entry('B/Book 2'), book: { rel_path: 'B/Book 2' } as QueueEntry['book'] },
        'Book 2',
      );
    });
    expect(mockDrop).toHaveBeenCalledWith('c', 1, 'B/Book 2', 'B/Book 2');
  });

  it('opens the full player on a phone, closing the sheet first', async () => {
    mockLayout = 'phone';
    usePlayerSheets.setState({ open: 'upnext' });
    const { result } = await renderHook(() => usePlayNow('c'));
    await act(async () => {
      await result.current(entry('B'), 'Book B');
    });
    expect(usePlayerSheets.getState().open).toBeNull();
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/player',
      params: { connection: 'c', libraryId: '1', path: 'B' },
    });
    expect(mockPlayBook).not.toHaveBeenCalled();
    expect(mockDrop).toHaveBeenCalledWith('c', 1, undefined, 'B');
  });

  it('keeps the entry and says so when the book cannot start', async () => {
    mockItem.mockRejectedValueOnce(new Error('offline'));
    const { result } = await renderHook(() => usePlayNow('c'));
    await act(async () => {
      await result.current(entry('B'), 'Book B');
    });
    expect(mockDrop).not.toHaveBeenCalled();
    expect(lastToast().title).toBe("Couldn't start Book B. Try again.");
  });
});
