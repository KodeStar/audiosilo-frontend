import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  // No full player on top (`usePlayerOnTop`, which `usePlayBook` reads).
  useSegments: () => [],
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/downloads/store', () => ({ useDownloadedCoverUri: () => null }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));
jest.mock('@/playback/store', () => ({
  usePlayer: (sel: (s: object) => unknown) =>
    sel({ nowPlaying: null, rate: 1, snapshot: { state: 'idle' } }),
  selectBookPosition: () => 0,
  selectIsPlaying: () => false,
}));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({ coverUrl: () => 'https://s/cover', authHeaders: () => ({}) }),
  useApis: () => [],
  useApiRegistry: () => ({ clients: new Map(), connections: [] }),
  ConnectionScope: ({ children }: { children: unknown }) => children,
}));

// The second chapter's title (the one the listener is in).
let mockSecondTitle = 'Holden';
let mockCaps: Record<string, boolean | undefined> = {};
let mockDays: { date: string; listened: number }[] | null = null;
let mockEpisode = false;
let mockPodcastLibrary = false;
let mockChapterCount = 3;
const mockChar = (name: string, chapter: number) => ({
  id: name,
  name,
  role: 'supporting',
  reveal: { chapter },
});
jest.mock('@/api/hooks', () => ({
  useSavedProgress: () => undefined,
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useCapability: (flag: string) => mockCaps[flag],
  useIsPodcastLibrary: () => mockPodcastLibrary,
  useBook: () => ({
    data: {
      title: "Caliban's War",
      author: 'James S. A. Corey',
      series: 'The Expanse',
      series_index: 2,
      asin: 'B008XKUPQ8',
      ...(mockEpisode ? { episode: { show_path: 'Daily News' } } : {}),
    },
  }),
  useChapters: () => ({
    data: {
      duration: 3000,
      files: [],
      chapters: [
        { title: 'Prologue', book_offset: 0, file_index: 0, file_path: 'a', start: 0, end: 1000 },
        {
          title: mockSecondTitle,
          book_offset: 1000,
          file_index: 0,
          file_path: 'a',
          start: 1000,
          end: 2000,
        },
        {
          title: 'Bobbie',
          book_offset: 2000,
          file_index: 0,
          file_path: 'a',
          start: 2000,
          end: 3000,
        },
      ].slice(0, mockChapterCount),
    },
  }),
  useBookmarks: () => ({ data: [{ position: 500 }] }),
  useBookMeta: (_lib: number, _path: string, enabled: boolean) => ({
    data: enabled
      ? {
          matched: true,
          web_url: 'u',
          work: {
            id: 'w',
            characters: [mockChar('Holden', 1), mockChar('Avasarala', 2), mockChar('Late', 3)],
            recaps: [{ id: 'r' }],
          },
        }
      : undefined,
  }),
  useMyStats: () => ({
    data: mockDays ? { days: mockDays } : undefined,
  }),
}));

/* eslint-disable import/first */
import { NowCard } from './now-card';
/* eslint-enable import/first */

const at = { connectionId: 'a', libraryId: 1, path: 'Corey/Calibans War' };
const saved = {
  connectionId: 'a',
  connectionName: 'Home',
  library_id: 1,
  path: at.path,
  position: 1500,
  duration: 3000,
  finished: false,
  playback_speed: 1.5,
  version: 0,
  device_id: 'd',
  updated_at: '2026-10-05T10:00:00Z',
};

beforeEach(() => {
  mockCaps = {};
  mockDays = null;
  mockSecondTitle = 'Holden';
  mockEpisode = false;
  mockPodcastLibrary = false;
  mockChapterCount = 3;
  mockPush.mockClear();
});

describe('NowCard', () => {
  it('shows where the listener is in the book and resumes that chapter', async () => {
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByText("Caliban's War")).toBeTruthy();
    expect(screen.getByText('Continue listening · The Expanse, book 2')).toBeTruthy();
    expect(screen.getByText('Chapter 2 of 3')).toBeTruthy();
    expect(screen.getByText('Holden')).toBeTruthy();
    expect(screen.getByRole('image', { name: '50% through the book' })).toBeTruthy();
    // 1500 s left at 1.5x.
    expect(screen.getByText('16m')).toBeTruthy();
    expect(screen.getByText('left at 1.5×')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume chapter 2' })).toBeTruthy();
  });

  // Bridge 2d-1: an episode is no book.
  it('says "through the episode", and no "Chapter 1 of 1", for a podcast episode', async () => {
    mockEpisode = true;
    mockChapterCount = 1;
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByText('through the episode')).toBeTruthy();
    expect(screen.queryByText('Chapter 1 of 1')).toBeNull();
    // An episode with chapters of its own still says where it is.
    mockChapterCount = 3;
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByText('Chapter 2 of 3')).toBeTruthy();
    expect(screen.getByRole('image', { name: '50% through the episode' })).toBeTruthy();
  });

  it('resumes an episode without a chapter in its label, known by its library before its item (R-5)', async () => {
    // The item has not said it is an episode yet: its podcast library already has.
    mockPodcastLibrary = true;
    mockChapterCount = 1;
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Resume chapter/ })).toBeNull();
    expect(screen.getByText('through the episode')).toBeTruthy();
  });

  it('names the chapter like the players do: a file name prettified, an untitled one by number', async () => {
    mockSecondTitle = 'wonderland_ch_01_64kb';
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByText('wonderland ch 01')).toBeTruthy();
    mockSecondTitle = '';
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByText('Chapter 2')).toBeTruthy();
  });

  it("says the chapter's title, not a number it contradicts (a Prologue first)", async () => {
    // The 2nd chapter is titled "Chapter 1": "Ch. 2 of 3 · Chapter 1" and "Resume
    // chapter 2" disagreed with the player's "Chapter 1".
    mockSecondTitle = 'Chapter 1';
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByRole('button', { name: 'Resume Chapter 1' })).toBeTruthy();
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.queryByText('Chapter 2 of 3')).toBeNull();
    expect(screen.getByText('Chapter 1')).toBeTruthy();
  });

  it('stacks like the phone card when it is narrow on a desktop (the Up next drawer open)', async () => {
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByText('Chapter 2 of 3')).toBeTruthy();
    await fireEvent(screen.getByTestId('now-card'), 'layout', {
      nativeEvent: { layout: { width: 420, height: 400 } },
    });
    expect(screen.getByText('Ch. 2 of 3')).toBeTruthy();
    expect(screen.queryByText('Chapter 2 of 3')).toBeNull();
  });

  it('estimates a finish date only from enough listening', async () => {
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.queryByText('finish at your pace')).toBeNull();
    mockDays = Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-0${i + 1}`, listened: 3600 }));
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.getByText('finish at your pace')).toBeTruthy();
  });

  it('counts only the characters met so far, and only with community metadata', async () => {
    await render(<NowCard at={at} saved={saved} />);
    expect(screen.queryByText("Who's who")).toBeNull();
    expect(screen.queryByText('Story so far')).toBeNull();

    mockCaps = { metadata: true };
    await render(<NowCard at={at} saved={saved} />);
    const who = screen.getByRole('button', { name: "Who's who, 2 characters met so far" });
    await fireEvent.press(who);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/book/[libraryId]',
      params: { libraryId: '1', connection: 'a', path: at.path, tab: 'characters' },
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Story so far' }));
    expect(mockPush).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ tab: 'recaps' }) }),
    );
  });
});
