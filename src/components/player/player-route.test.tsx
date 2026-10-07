import { act, render } from '@testing-library/react-native';

// The full player route (`src/app/player.tsx`): when it starts its book and when it jumps
// to its `?position=` / `?track=`. The test lives here because a file under `src/app` is a
// route to Expo Router.

let mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// Stable objects, as React Query hands them out: a refetch alone never re-runs the effect.
const mockBook = { rel_path: 'Author/Book', title: 'The Book' };
const mockChapters = {
  chapters: [],
  files: [{ rel_path: 'Author/Book/a.m4b', duration: 3600 }],
};
jest.mock('@/api/hooks', () => ({
  useBook: () => ({ data: mockBook }),
  useChapters: () => ({ data: mockChapters, isLoading: false }),
}));
jest.mock('@/api/provider', () => ({ useCid: (id?: string) => id ?? 'c' }));
jest.mock('@/components/player/player-view', () => ({ PlayerView: () => null }));
const mockSeekBook = jest.fn();
const mockGoToTrack = jest.fn();
const mockPlayBook = jest.fn();
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({
      nowPlaying: null,
      seekBook: (position: number) => mockSeekBook(position),
      goToTrack: (index: number) => mockGoToTrack(index),
      playBook: (...a: unknown[]) => mockPlayBook(...a),
    })),
  };
});

/* eslint-disable import/first */
import PlayerScreen from '@/app/player';
import { usePlayer } from '@/playback/store';
/* eslint-enable import/first */

type Loaded = { connectionId: string; libraryId: number; path: string } | null;
const THIS_BOOK = { connectionId: 'c', libraryId: 1, path: 'Author/Book' };

/** The store's write of `nowPlaying` (each call a NEW object, as every store write is). */
const setNowPlaying = (nowPlaying: Loaded) =>
  (usePlayer as unknown as { setState: (p: object) => void }).setState({
    nowPlaying: nowPlaying ? { ...nowPlaying } : null,
  });

/** The route's params: this book, plus the jump. */
const routeTo = (jump: { position?: string; track?: string }) => {
  mockParams = { connection: 'c', libraryId: '1', path: 'Author/Book', ...jump };
};

beforeEach(() => {
  setNowPlaying(null);
  mockSeekBook.mockReset();
  mockGoToTrack.mockReset();
  mockPlayBook.mockReset();
});

describe('the player route', () => {
  it('jumps to its position once, not again when the store replaces the playing book', async () => {
    setNowPlaying(THIS_BOOK);
    routeTo({ position: '600' });
    await render(<PlayerScreen />);
    expect(mockSeekBook.mock.calls).toEqual([[600]]);
    // The book's download lands while it plays: the store swaps it to the local files,
    // replacing nowPlaying with a new object for the SAME book. The listener has moved
    // on since the jump; jumping again would throw them back to 600 and save it.
    await act(async () => setNowPlaying(THIS_BOOK));
    await act(async () => setNowPlaying(THIS_BOOK));
    expect(mockSeekBook.mock.calls).toEqual([[600]]);
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  it('jumps again for a navigation with another position', async () => {
    setNowPlaying(THIS_BOOK);
    routeTo({ position: '600' });
    const r = await render(<PlayerScreen />);
    routeTo({ position: '900' });
    await r.rerender(<PlayerScreen />);
    expect(mockSeekBook.mock.calls).toEqual([[600], [900]]);
  });

  it('goes to its track once in the same way', async () => {
    setNowPlaying(THIS_BOOK);
    routeTo({ track: '3' });
    await render(<PlayerScreen />);
    await act(async () => setNowPlaying(THIS_BOOK));
    expect(mockGoToTrack.mock.calls).toEqual([[3]]);
    expect(mockSeekBook).not.toHaveBeenCalled();
  });

  it('starts a book that is not playing at its position, then never jumps there again', async () => {
    routeTo({ position: '600' });
    await render(<PlayerScreen />);
    expect(mockPlayBook.mock.calls).toEqual([['c', 1, mockBook, mockChapters, 600, undefined]]);
    // playBook loads the book (already at 600), then the hot-swap replaces it.
    await act(async () => setNowPlaying(THIS_BOOK));
    await act(async () => setNowPlaying(THIS_BOOK));
    expect(mockSeekBook).not.toHaveBeenCalled();
    expect(mockPlayBook).toHaveBeenCalledTimes(1);
  });
});
