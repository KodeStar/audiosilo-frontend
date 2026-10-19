import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { settleFlashList } from '@/testing/flash-list';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h), navigate: (h: unknown) => mockPush(h) },
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
// Previously on has its own tests; Home only places it.
jest.mock('./previously-on', () => ({ PreviouslyOnCard: () => null }));
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
  useSavedProgress: (lib: number, path: string) =>
    mockProgress.progress.find((p) => p.library_id === lib && p.path === path),
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
// A tile's actions menu has its own tests.
jest.mock('@/components/library/tile-actions', () => ({ TileActions: () => null }));
jest.mock('./use-narrator-shelf', () => ({ useNarratorShelf: () => undefined }));
jest.mock('./use-sync-pill', () => ({ useSyncPill: () => null }));
// Listening in the house has its own tests; Home only places it with its connections.
jest.mock('@/components/house/house-row', () => ({
  HouseRow: ({ connections }: { connections: { id: string }[] }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{`House: ${connections.map((c) => c.id).join(',')}`}</Text>;
  },
}));

// Which modules are on (Bridge Phase 2a): `useActiveModules` has its own suite.
let mockModulesOn: Record<string, boolean> = {};
const mockUseActiveModules = jest.fn();
jest.mock('@/modules/registry', () => ({
  ...jest.requireActual('@/modules/registry'),
  useActiveModules: (list: readonly { id: string }[]) => {
    mockUseActiveModules();
    return list.filter((m) => mockModulesOn[m.id]);
  },
}));

/* eslint-disable import/first */
import { useState } from 'react';
import { Text } from 'react-native';

import type { PlayerModule } from '@/modules/registry';

import { HomeScreen } from './home-screen';
/* eslint-enable import/first */

async function mountHome() {
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <HomeScreen />
    </QueryClientProvider>,
  );
  await settleFlashList();
}

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
  mockModulesOn = {};
  mockUseActiveModules.mockClear();
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

  it('places Listening in the house with the signed-in servers', async () => {
    await mountHome();
    expect(screen.getByText('House: a')).toBeTruthy();
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

  it('stacks This week under the Now card when the page column is too narrow for both', async () => {
    mockCaps = { user_stats: true };
    mockProgress.progress = [started('Book', '2026-10-04T00:00:00Z')];
    await mountHome();
    expect(screen.getByTestId('home-hero-beside')).toBeTruthy();
    // A 1024 desktop with the Up next drawer open leaves the column about 600 wide.
    await fireEvent(screen.getByTestId('home-column'), 'layout', {
      nativeEvent: { layout: { width: 600, height: 900 } },
    });
    expect(screen.queryByTestId('home-hero-beside')).toBeNull();
    expect(screen.getAllByText('This week')).toHaveLength(1);
    await fireEvent(screen.getByTestId('home-column'), 'layout', {
      nativeEvent: { layout: { width: 1200, height: 900 } },
    });
    expect(screen.getByTestId('home-hero-beside')).toBeTruthy();
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

describe("HomeScreen's module rails (Bridge Phase 2a)", () => {
  const FAKE: PlayerModule = {
    id: 'contributions',
    homeRails: ({ connections }) => (
      <Text>{`Module rail: ${connections.map((c) => c.id).join(',')}`}</Text>
    ),
  };
  const mountWith = async (modules: readonly PlayerModule[]) => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <HomeScreen modules={modules} />
      </QueryClientProvider>,
    );
    await settleFlashList();
  };
  const order = (...texts: string[]) => {
    const tree = JSON.stringify(screen.toJSON());
    return texts.map((t) => tree.indexOf(t));
  };

  it('renders as before with the empty registry, asking nothing', async () => {
    await mountHome();
    expect(screen.queryByText(/Module rail/)).toBeNull();
    expect(mockUseActiveModules).not.toHaveBeenCalled();
  });

  it("places an active module's rails after Next in your series, with the person's servers", async () => {
    mockModulesOn = { contributions: true };
    mockNext = {
      supported: true,
      isLoading: true,
      answers: [],
    };
    await mountWith([FAKE]);
    expect(screen.getByText('Module rail: a')).toBeTruthy();
    const [next, rail, house] = order('Next in your series', 'Module rail: a', 'House: a');
    expect(next).toBeGreaterThan(-1);
    expect(rail).toBeGreaterThan(next);
    expect(house).toBeGreaterThan(rail);
  });

  it('leaves a module that is off out', async () => {
    await mountWith([FAKE]);
    expect(screen.queryByText(/Module rail/)).toBeNull();
    expect(mockUseActiveModules).toHaveBeenCalled();
  });

  it("keeps each module's hooks its own as another turns on", async () => {
    // Rails that call their component as a plain function: its hooks must stay out of the
    // slot's, or a module turning on would change the slot's hook count.
    function HookedRail({ name }: { name: string }) {
      const [label] = useState(`Hooked rail ${name}`);
      return <Text>{label}</Text>;
    }
    const one: PlayerModule = { id: 'contributions', homeRails: () => HookedRail({ name: '1' }) };
    const two = {
      id: 'other',
      homeRails: () => HookedRail({ name: '2' }),
    } as unknown as PlayerModule;
    const modules = [one, two];
    const client = new QueryClient();
    const tree = () => (
      <QueryClientProvider client={client}>
        <HomeScreen modules={modules} />
      </QueryClientProvider>
    );
    mockModulesOn = { contributions: true };
    await render(tree());
    await settleFlashList();
    expect(screen.getByText('Hooked rail 1')).toBeTruthy();
    expect(screen.queryByText('Hooked rail 2')).toBeNull();
    mockModulesOn = { contributions: true, other: true };
    await screen.rerender(tree());
    expect(screen.getByText('Hooked rail 2')).toBeTruthy();
  });
});
