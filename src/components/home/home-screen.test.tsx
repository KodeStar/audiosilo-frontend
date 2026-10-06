import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h), navigate: (h: unknown) => mockPush(h) },
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
jest.mock('@/playback/progress-sync', () => ({ flushQueue: jest.fn(async () => undefined) }));
jest.mock('@/playback/store', () => ({
  usePlayer: (sel: (s: { nowPlaying: null }) => unknown) => sel({ nowPlaying: null }),
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/stores/session', () => ({
  useSession: (sel: (s: object) => unknown) =>
    sel({
      connections: [{ id: 'a', name: 'Home' }],
      defaultConnectionId: 'a',
      user: { username: 'alex' },
    }),
}));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({ coverUrl: () => 'https://s/cover', authHeaders: () => ({}) }),
  useApis: () => [],
  ConnectionScope: ({ children }: { children: unknown }) => children,
}));

type Progress = {
  connectionId: string;
  library_id: number;
  path: string;
  position: number;
  duration: number;
  finished: boolean;
  playback_speed: number;
  updated_at: string;
};
let mockCaps: Record<string, boolean | undefined> = {};
let mockProgress: { progress: Progress[]; isLoading: boolean; error: Error | null } = {
  progress: [],
  isLoading: false,
  error: null,
};
const mockToday = new Date().toISOString().slice(0, 10);
jest.mock('@/api/hooks', () => ({
  qk: { server: (c: string) => ['server', c] },
  useCapability: (flag: string) => mockCaps[flag],
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useAllProgressAll: () => mockProgress,
  useRecentAll: () => ({ books: [], isLoading: false, error: null }),
  useFavouritesAll: () => ({ favourites: [] }),
  useBook: () => ({ data: undefined }),
  useMyListening: () => ({
    data: mockCaps.user_stats
      ? {
          to: `${mockToday}T12:00:00Z`,
          utc_offset: 0,
          days: [{ date: mockToday, listened: 5400 }],
        }
      : undefined,
  }),
  useListeningGoal: () => ({
    data: mockCaps.user_stats
      ? { goal: { books_per_year: 24, updated_at: '' }, year: mockToday.slice(0, 4), finished: 3 }
      : undefined,
  }),
}));
jest.mock('./now-card', () => ({
  NowCard: ({ at }: { at: { path: string } }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{`Now card: ${at.path}`}</Text>;
  },
  NowCardSkeleton: () => null,
}));
let mockNext: { answers: unknown[]; supported: boolean | undefined; isLoading: boolean } = {
  answers: [],
  supported: undefined,
  isLoading: false,
};
jest.mock('./use-next-in-series', () => ({ useNextInSeries: () => mockNext }));
// The long-press menu is the old ProgressCard sheet; its own tests cover it.
jest.mock('@/components/library/progress-card', () => ({ ProgressMenuSheet: () => null }));
jest.mock('./use-narrator-shelf', () => ({ useNarratorShelf: () => undefined }));
jest.mock('./use-sync-pill', () => ({ useSyncPill: () => null }));

/* eslint-disable import/first */
import { HomeScreen } from './home-screen';
/* eslint-enable import/first */

const mountHome = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HomeScreen />
    </QueryClientProvider>,
  );

const started = (path: string, updated: string): Progress => ({
  connectionId: 'a',
  library_id: 1,
  path,
  position: 300,
  duration: 1000,
  finished: false,
  playback_speed: 1,
  updated_at: updated,
});

beforeEach(() => {
  mockCaps = {};
  mockProgress = { progress: [], isLoading: false, error: null };
  mockNext = { answers: [], supported: undefined, isLoading: false };
  mockLayout = 'desktop';
});

describe('HomeScreen', () => {
  it('greets the listener and offers the Library when nothing is in progress', async () => {
    await mountHome();
    expect(screen.getByText(/, alex\.$/)).toBeTruthy();
    expect(screen.getByText('Pick something to listen to')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Browse the library' })).toBeTruthy();
  });

  it('leads with the most recent book in progress and shelves the rest', async () => {
    mockProgress.progress = [
      started('Older', '2026-10-01T00:00:00Z'),
      started('Newest', '2026-10-04T00:00:00Z'),
    ];
    await mountHome();
    expect(screen.getByText('Now card: Newest')).toBeTruthy();
    expect(screen.getByText('1 more in progress')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Older, 30% · 11m left, 30% listened' }),
    ).toBeTruthy();
  });

  it('shows what went wrong, with a retry, when progress failed and nothing is shown', async () => {
    mockProgress = { progress: [], isLoading: false, error: new Error('down') };
    await mountHome();
    expect(screen.getByText("Couldn't load your progress")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('leaves out This week and Next in your series until the server says it has them', async () => {
    mockProgress.progress = [started('Book', '2026-10-04T00:00:00Z')];
    await mountHome();
    expect(screen.queryByText('This week')).toBeNull();
    expect(screen.queryByText('Next in your series')).toBeNull();

    mockCaps = { user_stats: false };
    mockNext = { answers: [], supported: false, isLoading: false };
    await mountHome();
    expect(screen.queryByText('This week')).toBeNull();
    expect(screen.queryByText('Next in your series')).toBeNull();
  });

  it('shows This week with the server’s stats', async () => {
    mockCaps = { user_stats: true };
    await mountHome();
    expect(screen.getByText('This week')).toBeTruthy();
    expect(screen.getByText('1h 30m')).toBeTruthy();
    expect(screen.getByText('1-day streak')).toBeTruthy();
    expect(screen.getByRole('image', { name: '3 of 24 books finished this year' })).toBeTruthy();
  });

  it('suggests the next book in a series, saying why', async () => {
    mockProgress.progress = [started('Book 1', '2026-10-04T00:00:00Z')];
    mockNext = {
      supported: true,
      isLoading: false,
      answers: [
        {
          candidate: {
            connectionId: 'a',
            libraryId: 1,
            path: 'Book 1',
            reason: { kind: 'current' },
          },
          answer: {
            source: 'community',
            work: { id: 'w2', title: 'Book Two', position: '2', authors: [], web_url: 'u' },
          },
        },
      ],
    };
    await mountHome();
    expect(screen.getByText('Next in your series')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: "Book Two, Not in your library, After the book you're on",
      }),
    ).toBeTruthy();
  });
});
