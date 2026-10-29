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
jest.mock('@/downloads/store', () => ({
  useIsDownloaded: () => false,
  useDownloadedCoverUri: () => null,
}));
jest.mock('@/playback/progress-sync', () => ({ flushQueue: jest.fn(async () => undefined) }));
jest.mock('@/reader/reading-progress', () => ({
  flushReadingQueue: jest.fn(async () => undefined),
}));
jest.mock('@/playback/store', () => ({
  usePlayer: (sel: (s: { nowPlaying: null }) => unknown) => sel({ nowPlaying: null }),
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
let mockConnections: { id: string; name: string; needsReconnect?: string }[] = [];
jest.mock('@/stores/session', () => ({
  useSession: (sel: (s: object) => unknown) =>
    sel({
      connections: mockConnections,
      defaultConnectionId: 'a',
      user: { username: 'alex' },
    }),
  // The reachability store (the servers pill) drops a removed connection's state.
  onConnectionRemoved: () => () => {},
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
let mockProgress: {
  progress: Progress[];
  isLoading: boolean;
  error: Error | null;
  offline?: boolean;
} = {
  progress: [],
  isLoading: false,
  error: null,
};
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({ useDeviceOnline: () => mockDeviceOnline }));
let mockRecent: { books: unknown[]; isLoading: boolean; error: Error | null } = {
  books: [],
  isLoading: false,
  error: null,
};
const mockToday = new Date().toISOString().slice(0, 10);
type Group = { connectionId: string; libraries: { id: number; kind?: string }[]; status: string };
let mockGroups: Group[] = [];
jest.mock('@/api/hooks', () => ({
  useSavedProgress: (lib: number, path: string) =>
    mockProgress.progress.find((p) => p.library_id === lib && p.path === path),
  qk: { server: (c: string) => ['server', c] },
  useCapability: (flag: string) => mockCaps[flag],
  // Every server says the same flags.
  useCapabilitiesAll: () => Object.fromEntries(mockConnections.map((c) => [c.id, mockCaps])),
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useAllProgressAll: () => mockProgress,
  useLibrariesAll: () => ({ groups: mockGroups }),
  useRecentAll: () => mockRecent,
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
const mockCandidates = jest.fn();
jest.mock('./use-next-in-series', () => ({
  useNextInSeries: (candidates: unknown) => {
    mockCandidates(candidates);
    return mockNext;
  },
}));
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
// New episodes has its own tests; Home places it with the servers and what to skip.
jest.mock('./new-episodes-rail', () => ({
  NewEpisodesRail: ({
    connections,
    skip,
    limit,
  }: {
    connections: { id: string }[];
    skip: Set<string>;
    limit: number;
  }) => {
    const { Text } = jest.requireActual('react-native');
    return (
      <Text>{`New episodes: ${connections.map((c) => c.id).join(',')} skip ${[...skip].join('|')} limit ${limit}`}</Text>
    );
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

import { ApiError } from '@/api/client';
import { useReachability } from '@/api/reachability';
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
  mockDeviceOnline = true;
  mockRecent = { books: [], isLoading: false, error: null };
  mockConnections = [{ id: 'a', name: 'Home' }];
  mockNext = { answers: [], supported: undefined, isLoading: false };
  mockLayout = 'desktop';
  mockCandidates.mockClear();
  mockGroups = [
    {
      connectionId: 'a',
      libraries: [
        { id: 1, kind: 'books' },
        { id: 9, kind: 'podcasts' },
      ],
      status: 'ready',
    },
  ];
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

  // Offline before progress was read (the drop came on another tab): the offline state,
  // not "Pick something to listen to" for a listener with books in progress.
  it('says it is offline, not "pick something", while progress waits for the network', async () => {
    mockProgress = { progress: [], isLoading: false, error: null, offline: true };
    await mountHome();
    expect(screen.getByTestId('home-offline')).toBeTruthy();
    expect(screen.queryByText('Pick something to listen to')).toBeNull();
  });

  // Another server's finished rows say nothing about the paused server's Now book.
  it('says it is offline when only finished rows answered and another server waits', async () => {
    mockProgress = {
      progress: [{ ...started('Done', '2026-10-04T00:00:00Z'), position: 1000, finished: true }],
      isLoading: false,
      error: null,
      offline: true,
    };
    await mountHome();
    expect(screen.getByTestId('home-offline')).toBeTruthy();
    expect(screen.queryByText('Pick something to listen to')).toBeNull();
  });

  it('says it is offline, with no Retry, when progress failed as the network went', async () => {
    mockDeviceOnline = false;
    mockProgress = { progress: [], isLoading: false, error: new TypeError('Failed to fetch') };
    await mountHome();
    expect(screen.getByTestId('home-offline')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your progress")).toBeNull();
  });

  it('keeps the cached progress offline', async () => {
    mockDeviceOnline = false;
    mockProgress = {
      progress: [started('Cached', '2026-10-04T00:00:00Z')],
      isLoading: false,
      error: null,
      offline: true,
    };
    await mountHome();
    expect(screen.getByText('Now card: Cached')).toBeTruthy();
    expect(screen.queryByTestId('home-offline')).toBeNull();
  });

  // frontend#124: a revoked session is one sign-in state, not load errors with Retry.
  it('shows one sign-in state with Reconnect, and no Retry, when the session was refused', async () => {
    mockConnections = [{ id: 'a', name: 'Home', needsReconnect: 'auth' }];
    mockProgress = { progress: [], isLoading: false, error: new ApiError(401, 'unauthorized') };
    mockRecent = { books: [], isLoading: false, error: new ApiError(401, 'unauthorized') };
    await mountHome();
    expect(screen.getByText('Sign in again to Home')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.queryByText("Couldn't load your progress")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText('Recently added')).toBeNull();
  });

  // frontend#131: never a green "2 servers" over a server that is down.
  it('names a server that is not answering on the servers pill', async () => {
    mockConnections = [
      { id: 'a', name: 'Home' },
      { id: 'b', name: "Maya's Shelf" },
    ];
    await mountHome();
    expect(screen.getByText('2 servers')).toBeTruthy();
    useReachability.setState({ online: { b: false } });
    try {
      await mountHome();
      expect(screen.getByText("Maya's Shelf isn't answering")).toBeTruthy();
      expect(screen.queryByText('2 servers')).toBeNull();
    } finally {
      screen.unmount();
      useReachability.setState({ online: {} });
    }
  });

  // CONNECT-04: a phone names the server that is down too, not only "offline".
  it('names a server that is not answering on a phone', async () => {
    mockLayout = 'phone';
    mockConnections = [
      { id: 'a', name: 'Home' },
      { id: 'b', name: "Maya's Shelf" },
    ];
    // All answering: a phone shows no servers count.
    await mountHome();
    expect(screen.queryByText('2 servers')).toBeNull();
    useReachability.setState({ online: { b: false } });
    try {
      await mountHome();
      expect(screen.getByText("Maya's Shelf isn't answering")).toBeTruthy();
    } finally {
      screen.unmount();
      useReachability.setState({ online: {} });
    }
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

  it('places New episodes between Next in your series and the module rails, skipping started ones', async () => {
    mockModulesOn = { contributions: true };
    mockNext = { supported: true, isLoading: true, answers: [] };
    mockProgress.progress = [
      started('Now', '2026-10-05T00:00:00Z'),
      started('Pod/Ep 1.mp3', '2026-10-04T00:00:00Z'),
    ];
    await mountWith([FAKE]);
    const label = 'New episodes: a skip a:1:Now|a:1:Pod/Ep 1.mp3 limit 15';
    expect(screen.getByText(label)).toBeTruthy();
    const [next, episodes, rail] = order('Next in your series', label, 'Module rail: a');
    expect(episodes).toBeGreaterThan(next);
    expect(rail).toBeGreaterThan(episodes);
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

// Bridge Phase 2d-1: episodes lead the Now card and Continue listening like any book,
// but Home's book shelves hold books only, and `/next` is never asked about one.
describe("HomeScreen's book shelves leave episodes out", () => {
  const episode = (path: string, over: Partial<Progress> = {}): Progress => ({
    ...started(path, '2026-10-06T00:00:00Z'),
    library_id: 9,
    ...over,
  });
  const askedPaths = () =>
    (mockCandidates.mock.calls.at(-1)?.[0] as { path: string }[]).map((c) => c.path);

  it('asks /next about books only, and keeps finished episodes out of Recently finished', async () => {
    mockProgress.progress = [
      episode('Serial/S1E2.mp3'),
      episode('Daily/Weather.mp3', { finished: true, position: 1000 }),
      started('Book', '2026-10-04T00:00:00Z'),
      { ...started('Done', '2026-10-03T00:00:00Z'), finished: true, position: 1000 },
    ];
    await mountHome();
    // The episode played last still leads the Now card.
    expect(screen.getByText('Now card: Serial/S1E2.mp3')).toBeTruthy();
    expect(askedPaths()).toEqual(['Book', 'Done']);
    expect(screen.getByText('Recently finished')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Weather/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Done/ })).toBeTruthy();
  });

  it('asks nothing about a server whose libraries are still loading', async () => {
    mockGroups = [{ connectionId: 'a', libraries: [], status: 'loading' }];
    mockProgress.progress = [episode('Serial/S1E2.mp3'), started('Book', '2026-10-04T00:00:00Z')];
    await mountHome();
    expect(askedPaths()).toEqual([]);
    // A server whose list failed is read as books (an older server has no podcasts).
    mockGroups = [{ connectionId: 'a', libraries: [], status: 'error' }];
    await mountHome();
    expect(askedPaths()).toEqual(['Serial/S1E2.mp3', 'Book']);
  });

  it('holds the book shelves with skeletons while the libraries load, then fills them', async () => {
    mockCaps = { next_book: true };
    // Every row is held, so `/next` has no candidate yet and can't say it is supported.
    mockNext = { answers: [], supported: undefined, isLoading: false };
    mockGroups = [{ connectionId: 'a', libraries: [], status: 'loading' }];
    // A short recent book: with the books in progress, two smart shelves.
    mockRecent.books = [
      {
        connectionId: 'a',
        library_id: 1,
        rel_path: 'Short',
        title: 'Short',
        author: 'A',
        duration: 3600,
        added_at: '2026-01-01T00:00:00Z',
      },
    ];
    mockProgress.progress = [
      started('Now', '2026-10-05T00:00:00Z'),
      started('Book', '2026-10-04T00:00:00Z'),
      { ...started('Done', '2026-10-03T00:00:00Z'), finished: true, position: 1000 },
    ];
    const client = new QueryClient();
    const view = await render(
      <QueryClientProvider client={client}>
        <HomeScreen />
      </QueryClientProvider>,
    );
    await settleFlashList();
    // Their rows are not yet known to be books: each shelf keeps its place.
    expect(screen.getByText('Next in your series')).toBeTruthy();
    expect(screen.getByText('Smart shelves')).toBeTruthy();
    expect(screen.getByText('Recently finished')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Done/ })).toBeNull();
    // Next in your series, Smart shelves and Recently finished (Continue listening has rows).
    expect(screen.getAllByTestId('shelf-skeleton', { includeHiddenElements: true })).toHaveLength(
      3,
    );

    mockGroups = [{ connectionId: 'a', libraries: [{ id: 1, kind: 'books' }], status: 'ready' }];
    mockNext = { answers: [], supported: true, isLoading: false };
    await view.rerender(
      <QueryClientProvider client={client}>
        <HomeScreen />
      </QueryClientProvider>,
    );
    await settleFlashList();
    expect(screen.getByText('Smart shelves')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Done/ })).toBeTruthy();
    // Nothing next to suggest once loaded: that shelf goes, and no skeleton is left.
    expect(screen.queryByText('Next in your series')).toBeNull();
    expect(screen.queryByTestId('shelf-skeleton', { includeHiddenElements: true })).toBeNull();
  });

  it('holds no Next in your series for rows of a server without /next', async () => {
    mockGroups = [{ connectionId: 'a', libraries: [], status: 'loading' }];
    mockProgress.progress = [
      started('Now', '2026-10-05T00:00:00Z'),
      { ...started('Done', '2026-10-03T00:00:00Z'), finished: true, position: 1000 },
    ];
    await mountHome();
    expect(screen.getByText('Recently finished')).toBeTruthy();
    expect(screen.queryByText('Next in your series')).toBeNull();
  });

  it('holds no shelf for rows of a server whose libraries have loaded as podcasts', async () => {
    mockProgress.progress = [
      episode('Serial/S1E2.mp3'),
      episode('Daily/Weather.mp3', { finished: true, position: 1000 }),
    ];
    await mountHome();
    expect(screen.queryByText('Smart shelves')).toBeNull();
    expect(screen.queryByText('Recently finished')).toBeNull();
    expect(screen.queryByTestId('shelf-skeleton', { includeHiddenElements: true })).toBeNull();
  });

  it('never suggests an episode a /next answer leads to', async () => {
    mockProgress.progress = [started('Book', '2026-10-04T00:00:00Z')];
    mockNext = {
      supported: true,
      isLoading: false,
      answers: [
        {
          candidate: { connectionId: 'a', libraryId: 1, path: 'Book', reason: { kind: 'current' } },
          answer: {
            source: 'folder',
            next: { library_id: 9, path: 'Daily/Council.mp3' },
            book: { library_id: 9, rel_path: 'Daily/Council.mp3', title: 'Council' },
          },
        },
      ],
    };
    await mountHome();
    expect(screen.queryByText('Next in your series')).toBeNull();
  });
});
