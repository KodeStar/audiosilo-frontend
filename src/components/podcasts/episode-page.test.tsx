import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Book, Progress } from '@/api/types';

jest.mock('@/api/provider', () => ({ useScopedCid: () => 'c1' }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));
jest.mock('@/components/player/use-playing-pins', () => ({
  useBookAnnotations: () => ({ pins: [] }),
}));
jest.mock('@/components/player/use-listening-position', () => ({
  useBookPlace: (_t: unknown, saved: number | undefined) => ({ resume: saved }),
}));
// The chapter list has its own suite: here, only whether it shows.
jest.mock('@/components/book/book-chapters-tab', () => ({
  BookChaptersTab: ({ list, episode }: { list: { rows: unknown[] }; episode?: boolean }) => {
    const { Text } = jest.requireActual('react-native');
    return (
      <Text testID="chapters">{`${list.rows.length} chapters${episode ? ', episode' : ''}`}</Text>
    );
  },
}));
const mockOpenShow = jest.fn();
jest.mock('@/lib/open', () => ({ useOpen: () => ({ openPodcastShow: mockOpenShow }) }));
const mockPlay = jest.fn();
jest.mock('@/components/player/use-play-book', () => ({ usePlayBook: () => mockPlay }));
const mockRequest = jest.fn();
jest.mock('@/playback/episode-fetch', () => {
  const { create } = jest.requireActual('zustand');
  return {
    useEpisodeFetch: create(() => ({ pending: null })),
    requestEpisodeFetch: (...a: unknown[]) => mockRequest(...a),
  };
});
let mockLoaded = false;
jest.mock('@/playback/store', () => ({
  usePlayer: (sel: (s: object) => unknown) => sel({}),
  selectIsTransportLive: () => true,
}));
jest.mock('@/components/player/playing-target', () => ({ selectIsLoaded: () => () => mockLoaded }));

let mockBook: Book | undefined;
let mockProgress: Progress | null = null;
let mockFetchStatus: unknown;
let mockCaps: Record<string, boolean | undefined> = {};
let mockChapters: unknown;
jest.mock('@/api/hooks', () => ({
  useBook: () => ({ data: mockBook, isLoading: false, refetch: jest.fn() }),
  useBookProgress: () => ({ data: mockProgress }),
  useCapability: (flag: string) => mockCaps[flag],
  useChapters: () => ({ data: mockChapters, isLoading: false }),
  usePodcastFetchStatus: () => ({ data: mockFetchStatus }),
  usePodcastShows: () => ({ data: [{ path: 'Daily News', title: 'The Daily News' }] }),
}));

/* eslint-disable import/first */
import { episodeBook, wire2b } from '@/testing/podcast-fixtures';

import { EpisodePage } from './episode-page';
/* eslint-enable import/first */

const PATH = 'Daily News/2026-10-21 Monday.mp3';
const mount = () => render(<EpisodePage libraryId={5} path={PATH} />);

beforeEach(() => {
  mockBook = episodeBook({ description: 'What happened on Monday.' });
  mockProgress = null;
  mockFetchStatus = undefined;
  mockCaps = { podcast_fetch: true };
  mockChapters = undefined;
  mockLoaded = false;
  mockPlay.mockReset().mockResolvedValue(undefined);
  mockRequest.mockReset();
  mockOpenShow.mockReset();
});

describe('EpisodePage', () => {
  it('shows the episode with a link to its show, and plays it the normal way', async () => {
    await mount();
    expect(screen.getByText('Monday')).toBeTruthy();
    expect(screen.getByText('What happened on Monday.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('episode-show-link'));
    expect(mockOpenShow).toHaveBeenCalledWith('c1', 5, 'Daily News');
    await fireEvent.press(screen.getByTestId('episode-page-play'));
    expect(mockPlay).toHaveBeenCalledWith(
      { connectionId: 'c1', libraryId: 5, path: PATH },
      { toggle: true, viaBookPage: true },
    );
    expect(screen.queryByTestId('chapters')).toBeNull();
  });

  it('says Resume once started', async () => {
    mockProgress = { position: 300, duration: 1800, finished: false } as Progress;
    await mount();
    expect(screen.getByText('Resume')).toBeTruthy();
  });

  it('offers Try again after a failed fetch, asking the server again', async () => {
    mockFetchStatus = wire2b.failed;
    await mount();
    expect(screen.queryByTestId('episode-page-play')).toBeNull();
    await fireEvent.press(screen.getByTestId('episode-page-retry'));
    expect(mockRequest).toHaveBeenCalledWith(
      { connectionId: 'c1', libraryId: 5, path: PATH },
      mockBook,
      {},
      { retry: true },
    );
  });

  it('cannot play an episode not on the server while nothing can fetch it', async () => {
    mockCaps = { podcast_fetch: false };
    await mount();
    expect(screen.getByTestId('episode-page-play').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    // Beside it, why.
    expect(screen.getByTestId('episode-page-reason').props.children).toBe(
      "Your server can't download episodes right now.",
    );
  });

  it("says why the server couldn't get it, beside Try again", async () => {
    mockFetchStatus = { ...wire2b.failed, error: { code: 'too_large', message: 'big' } };
    await mount();
    expect(screen.getByTestId('episode-page-retry')).toBeTruthy();
    expect(screen.getByTestId('episode-page-reason').props.children).toBe(
      'This episode is too large for your server to keep.',
    );
  });

  it('offers Try again when not available for a reason it cannot name (R-23)', async () => {
    mockFetchStatus = {
      ...wire2b.failed,
      state: 'unavailable',
      error: { code: 'something_new', message: 'x' },
    };
    await mount();
    expect(screen.getByTestId('episode-page-retry')).toBeTruthy();
    expect(screen.queryByTestId('episode-page-play')).toBeNull();
  });

  it('gives no reason while it can play', async () => {
    await mount();
    expect(screen.queryByTestId('episode-page-reason')).toBeNull();
  });

  it('notes a changed timeline only under a saved place', async () => {
    mockBook = episodeBook({}, { timeline_changed: true });
    await mount();
    expect(screen.queryByTestId('episode-timeline-changed')).toBeNull();
    mockProgress = { position: 300, duration: 1800, finished: false } as Progress;
    await mount();
    expect(screen.getByTestId('episode-timeline-changed')).toBeTruthy();
  });

  it("lists the chapters the episode's file carries", async () => {
    mockChapters = {
      duration: 1800,
      files: [{ path: PATH, duration: 1800, offset: 0 }],
      chapters: [
        { title: 'Intro', start: 0, end: 600, file_path: PATH, book_offset: 0 },
        { title: 'Main', start: 600, end: 1800, file_path: PATH, book_offset: 600 },
      ],
    };
    await mount();
    // Worded for an episode ("The whole episode", BRIDGE-12).
    expect(screen.getByTestId('chapters').props.children).toBe('2 chapters, episode');
  });
});
