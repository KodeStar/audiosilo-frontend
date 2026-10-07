import { act, renderHook } from '@testing-library/react-native';

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
// A subscription to the route (re-renders on every navigation): must not be used.
const mockUseSegments = jest.fn(() => ['(app)']);
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  useSegments: () => mockUseSegments(),
}));
// The navigator, read at the press (`currentNavState`): the shell showing `mockPage`,
// with `mockTop` over it.
let mockTop = '(app)';
let mockPage: { name: string; params?: object } = { name: 'library/index' };
const mockNavReads = jest.fn();
jest.mock('@/lib/root-stack', () => ({
  ...jest.requireActual('@/lib/root-stack'),
  currentNavState: () => {
    mockNavReads();
    const shell = { name: '(app)', state: { routes: [mockPage] } };
    return mockTop === '(app)'
      ? { index: 0, routes: [shell] }
      : { index: 1, routes: [shell, { name: mockTop }] };
  },
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
const mockPlayBook = jest.fn();
const mockToggle = jest.fn();
const mockSeekBook = jest.fn();
const mockGoToTrack = jest.fn();
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    selectBookKey: (s: { key: string | null }) => s.key,
    selectIsTransportLive: (s: { live: boolean }) => s.live,
    usePlayer: create(() => ({
      key: null,
      live: false,
      playBook: (...a: unknown[]) => mockPlayBook(...a),
      toggle: () => mockToggle(),
      seekBook: (p: number) => mockSeekBook(p),
      goToTrack: (i: number) => mockGoToTrack(i),
    })),
  };
});

/* eslint-disable import/first */
import { queryClient } from '@/api/provider';
import { usePlayer } from '@/playback/store';

import { type PlayOptions, usePlayBook } from './use-play-book';
/* eslint-enable import/first */

const target = { connectionId: 'c', libraryId: 1, path: 'Book' };
const setPlayer = (s: { key: string | null; live: boolean }) =>
  (usePlayer as unknown as { setState: (p: object) => void }).setState(s);

async function play(opts?: PlayOptions) {
  const { result } = await renderHook(() => usePlayBook());
  await act(async () => {
    await result.current(target, opts);
  });
}

beforeEach(() => {
  queryClient.clear();
  mockLayout = 'desktop';
  mockTop = '(app)';
  mockPage = { name: 'library/index' };
  mockNavReads.mockReset();
  mockUseSegments.mockClear();
  setPlayer({ key: null, live: false });
  mockItem.mockReset().mockResolvedValue({ rel_path: 'Book' });
  mockChapters.mockReset().mockResolvedValue({ files: [] });
  mockPlayBook.mockReset();
  mockToggle.mockReset();
  mockSeekBook.mockReset();
  mockGoToTrack.mockReset();
  mockPush.mockReset();
});

describe('usePlayBook', () => {
  // One per visible Library row: reading "player on top" through a subscription
  // re-rendered every row on every navigation. It is read at the press instead.
  it('reads where the player is only when pressed, never while rendering', async () => {
    mockLayout = 'phone';
    const { result } = await renderHook(() => usePlayBook());
    expect(mockNavReads).not.toHaveBeenCalled();
    expect(mockUseSegments).not.toHaveBeenCalled();
    await act(async () => {
      await result.current(target);
    });
    expect(mockNavReads).toHaveBeenCalledTimes(1);
  });

  it('starts a book under the dock on tablet and desktop, through its own connection', async () => {
    await play();
    expect(mockItem).toHaveBeenCalledWith(1, 'Book', expect.anything());
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c',
      1,
      { rel_path: 'Book' },
      { files: [] },
      undefined,
      undefined,
      undefined,
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens the full player on a phone, over the book page when asked', async () => {
    mockLayout = 'phone';
    await play();
    expect(mockPush.mock.calls.map((c) => c[0].pathname)).toEqual(['/player']);
    mockPush.mockReset();
    await play({ viaBookPage: true });
    expect(mockPush.mock.calls.map((c) => c[0].pathname)).toEqual(['/book/[libraryId]', '/player']);
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  it('plays a loaded book on (never pausing it) unless the button is a toggle', async () => {
    setPlayer({ key: 'c:1:Book', live: true });
    await play();
    expect(mockToggle).not.toHaveBeenCalled();
    setPlayer({ key: 'c:1:Book', live: false });
    await play();
    expect(mockToggle).toHaveBeenCalledTimes(1);
    setPlayer({ key: 'c:1:Book', live: true });
    await play({ toggle: true });
    expect(mockToggle).toHaveBeenCalledTimes(2);
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  // Which way each press goes is `playRoute`'s (its table); these pin the wiring.
  it('opens the player at the place, and over no second copy of the book page', async () => {
    mockLayout = 'phone';
    await play({ viaBookPage: true, at: { position: 62_810 } });
    expect(mockPush.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ pathname: '/book/[libraryId]' }),
      {
        pathname: '/player',
        params: { connection: 'c', libraryId: '1', path: 'Book', position: '62810' },
      },
    ]);
    mockPush.mockReset();
    mockPage = {
      name: 'book/[libraryId]',
      params: { connection: 'c', libraryId: '1', path: 'Book' },
    };
    await play({ viaBookPage: true, at: { track: 2 } });
    expect(mockPush.mock.calls.map((c) => c[0])).toEqual([
      {
        pathname: '/player',
        params: { connection: 'c', libraryId: '1', path: 'Book', track: '2' },
      },
    ]);
  });

  it('jumps the loaded book there and plays it on, also when it was paused', async () => {
    setPlayer({ key: 'c:1:Book', live: false });
    await play({ at: { position: 1000 } });
    expect(mockSeekBook).toHaveBeenCalledWith(1000);
    expect(mockToggle).toHaveBeenCalledTimes(1);
    setPlayer({ key: 'c:1:Book', live: true });
    await play({ at: { track: 3 } });
    expect(mockGoToTrack).toHaveBeenCalledWith(3);
    expect(mockToggle).toHaveBeenCalledTimes(1);
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  it('starts another book in place at the place, under the open player on a phone', async () => {
    mockLayout = 'phone';
    mockTop = 'player';
    await play({ at: { position: 2000 } });
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c',
      1,
      { rel_path: 'Book' },
      { files: [] },
      2000,
      undefined,
      undefined,
    );
    expect(mockPush).not.toHaveBeenCalled();
  });
});
