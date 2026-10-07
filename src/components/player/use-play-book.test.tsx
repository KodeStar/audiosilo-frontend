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
// The root stack's top route, read at the press (`currentNavState`).
let mockTop = '(app)';
const mockNavReads = jest.fn();
jest.mock('@/lib/root-stack', () => ({
  ...jest.requireActual('@/lib/root-stack'),
  currentNavState: () => {
    mockNavReads();
    return { index: 1, routes: [{ name: '(app)' }, { name: mockTop }] };
  },
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
const mockPlayBook = jest.fn();
const mockToggle = jest.fn();
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
    })),
  };
});

/* eslint-disable import/first */
import { queryClient } from '@/api/provider';
import { usePlayer } from '@/playback/store';

import { usePlayBook } from './use-play-book';
/* eslint-enable import/first */

const target = { connectionId: 'c', libraryId: 1, path: 'Book' };
const setPlayer = (s: { key: string | null; live: boolean }) =>
  (usePlayer as unknown as { setState: (p: object) => void }).setState(s);

async function play(opts?: { toggle?: boolean; viaBookPage?: boolean }) {
  const { result } = await renderHook(() => usePlayBook());
  await act(async () => {
    await result.current(target, opts);
  });
}

beforeEach(() => {
  queryClient.clear();
  mockLayout = 'desktop';
  mockTop = '(app)';
  mockNavReads.mockReset();
  mockUseSegments.mockClear();
  setPlayer({ key: null, live: false });
  mockItem.mockReset().mockResolvedValue({ rel_path: 'Book' });
  mockChapters.mockReset().mockResolvedValue({ files: [] });
  mockPlayBook.mockReset();
  mockToggle.mockReset();
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

  it('toggles a loaded book in place on a phone too, with toggle', async () => {
    mockLayout = 'phone';
    setPlayer({ key: 'c:1:Book', live: true });
    await play({ toggle: true });
    expect(mockToggle).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });

  // Up next's sheet over the full player (Play now): pushing another player would stack
  // a second one, and the credits of that book would close onto an empty player.
  it('starts in place on a phone while the full player is on top, never pushing another', async () => {
    mockLayout = 'phone';
    mockTop = 'player';
    await play({ viaBookPage: true });
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c',
      1,
      { rel_path: 'Book' },
      { files: [] },
      undefined,
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('plays the loaded book on under the open player on a phone', async () => {
    mockLayout = 'phone';
    mockTop = 'player';
    setPlayer({ key: 'c:1:Book', live: false });
    await play();
    expect(mockToggle).toHaveBeenCalledTimes(1);
    setPlayer({ key: 'c:1:Book', live: true });
    await play();
    expect(mockToggle).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockPlayBook).not.toHaveBeenCalled();
  });
});
