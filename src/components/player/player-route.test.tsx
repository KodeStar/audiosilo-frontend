import { act, render, waitFor } from '@testing-library/react-native';

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
let mockBook: object = { rel_path: 'Author/Book', title: 'The Book' };
const plainBook = mockBook;
let mockPodcastFetch: boolean | undefined = false;
const mockChapters = {
  chapters: [],
  files: [{ rel_path: 'Author/Book/a.m4b', duration: 3600 }],
};
jest.mock('@/api/hooks', () => ({
  useBook: () => ({ data: mockBook }),
  useCapability: () => mockPodcastFetch,
  useChapters: () => ({ data: mockChapters, isLoading: false }),
}));
// The episode fetch (Bridge Phase 2d-1): its store is real, its requests are not.
const mockRequestFetch = jest.fn();
jest.mock('@/playback/episode-fetch', () => {
  const { create } = jest.requireActual('zustand');
  const actual = jest.requireActual('@/playback/episode-fetch');
  return {
    useEpisodeFetch: create(() => ({ pending: null })),
    isAbsentEpisode: actual.isAbsentEpisode,
    needsEpisodeFetch: actual.needsEpisodeFetch,
    requestEpisodeFetch: (...a: unknown[]) => mockRequestFetch(...a),
    cancelEpisodeFetchUnless: jest.fn(),
    cancelEpisodeFetchOf: jest.fn(),
  };
});
jest.mock('@/components/podcasts/episode-fetch-panel', () => {
  const { View } = jest.requireActual('react-native');
  return { EpisodeFetchPanel: () => <View testID="episode-fetch-panel" /> };
});
jest.mock('@/api/provider', () => ({ useCid: (id?: string) => id ?? 'c' }));
jest.mock('@/components/player/player-view', () => ({ PlayerView: () => null }));
const mockDrop = jest.fn();
jest.mock('@/components/player/drop-started', () => ({
  dropStartedBook: (...a: unknown[]) => mockDrop(...a),
}));
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
import { useEpisodeFetch } from '@/playback/episode-fetch';
import { usePlayer } from '@/playback/store';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';
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
  // The route's connection is signed in (an unknown one gets the not-found state:
  // `useRouteConnection`).
  useSession.setState({ connections: [{ id: 'c' } as never] });
  setNowPlaying(null);
  mockSeekBook.mockReset();
  mockGoToTrack.mockReset();
  mockPlayBook.mockReset().mockResolvedValue(undefined);
  mockDrop.mockReset();
  mockRequestFetch.mockReset();
  mockBook = plainBook;
  mockPodcastFetch = false;
  useEpisodeFetch.setState({ pending: null });
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
    // The book you're on leaves Up next (PLAYER-04), once, after its start.
    await waitFor(() => expect(mockDrop.mock.calls).toEqual([['c', 1, 'Author/Book']]));
    // playBook loads the book (already at 600), then the hot-swap replaces it.
    await act(async () => setNowPlaying(THIS_BOOK));
    await act(async () => setNowPlaying(THIS_BOOK));
    expect(mockSeekBook).not.toHaveBeenCalled();
    expect(mockPlayBook).toHaveBeenCalledTimes(1);
  });

  it("shows the gate for another person's book, and starts it once they are chosen", async () => {
    try {
      useProfiles.setState({
        hydrated: true,
        profiles: [
          { id: 'me', name: 'Chris', connectionIds: ['mine'] },
          { id: 'sam', name: 'Sam', connectionIds: ['c'] },
        ],
        activeProfileId: 'me',
      });
      routeTo({});
      const r = await render(<PlayerScreen />);
      expect(r.getByTestId('other-person-gate', { includeHiddenElements: true })).toBeTruthy();
      expect(mockPlayBook).not.toHaveBeenCalled();
      // The switch: the start the gate held back happens now (no latch recorded it).
      await act(async () => useProfiles.setState({ activeProfileId: 'sam' }));
      expect(mockPlayBook).toHaveBeenCalledTimes(1);
    } finally {
      resetProfilesForTests();
    }
  });

  describe('an episode not on its server yet (Bridge Phase 2d-1)', () => {
    const episodeBook = {
      rel_path: 'Author/Book',
      title: 'Monday',
      episode: { show_path: 'Author', downloaded: false },
    };

    it('hands it to the fetch, never to playBook, and shows the fetch in its place', async () => {
      mockBook = episodeBook;
      mockPodcastFetch = true;
      routeTo({ position: '30' });
      const r = await render(<PlayerScreen />);
      expect(mockPlayBook).not.toHaveBeenCalled();
      expect(mockRequestFetch.mock.calls).toEqual([
        [
          { connectionId: 'c', libraryId: 1, path: 'Author/Book' },
          episodeBook,
          { position: 30, track: undefined },
        ],
      ]);
      await act(async () =>
        useEpisodeFetch.setState({
          pending: { key: 'c:1:Author/Book', phase: 'waiting' } as never,
        }),
      );
      expect(r.getByTestId('episode-fetch-panel')).toBeTruthy();
      // Asked once: a re-render (the fetch's progress) does not ask again.
      await r.rerender(<PlayerScreen />);
      expect(mockRequestFetch).toHaveBeenCalledTimes(1);
    });

    it("waits for the server's flags before choosing how to start it", async () => {
      mockBook = episodeBook;
      mockPodcastFetch = undefined;
      routeTo({});
      const r = await render(<PlayerScreen />);
      expect(mockPlayBook).not.toHaveBeenCalled();
      expect(mockRequestFetch).not.toHaveBeenCalled();
      mockPodcastFetch = true;
      await r.rerender(<PlayerScreen />);
      expect(mockRequestFetch).toHaveBeenCalledTimes(1);
    });

    it('plays it as before on a server that does not fetch on demand', async () => {
      mockBook = episodeBook;
      mockPodcastFetch = false;
      routeTo({});
      await render(<PlayerScreen />);
      expect(mockRequestFetch).not.toHaveBeenCalled();
      expect(mockPlayBook).toHaveBeenCalledTimes(1);
    });

    it("shows the next episode's fetch once its own episode ended, nothing loaded", async () => {
      mockBook = { ...episodeBook, episode: { show_path: 'Author', downloaded: true } };
      mockPodcastFetch = true;
      setNowPlaying(THIS_BOOK);
      routeTo({});
      const r = await render(<PlayerScreen />);
      // Up next's head, an episode still to fetch, while this one plays.
      await act(async () =>
        useEpisodeFetch.setState({ pending: { key: 'c:1:Show/Next', phase: 'waiting' } as never }),
      );
      expect(r.queryByTestId('episode-fetch-panel')).toBeNull();
      // It ends: nothing is loaded, and the fetch shows in its place.
      await act(async () => setNowPlaying(null));
      expect(r.getByTestId('episode-fetch-panel')).toBeTruthy();
      expect(mockPlayBook).not.toHaveBeenCalled();
    });

    it("never shows another episode's fetch before its own book starts", async () => {
      useEpisodeFetch.setState({ pending: { key: 'c:1:Show/Other', phase: 'waiting' } as never });
      routeTo({});
      const r = await render(<PlayerScreen />);
      expect(r.queryByTestId('episode-fetch-panel')).toBeNull();
      expect(mockPlayBook).toHaveBeenCalledTimes(1);
    });

    it('plays a downloaded episode at once', async () => {
      mockBook = { ...episodeBook, episode: { show_path: 'Author', downloaded: true } };
      mockPodcastFetch = true;
      routeTo({});
      await render(<PlayerScreen />);
      expect(mockRequestFetch).not.toHaveBeenCalled();
      expect(mockPlayBook).toHaveBeenCalledTimes(1);
    });
  });
});
