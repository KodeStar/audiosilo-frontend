import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { Book } from '@/api/types';

import type { KidsStories } from './use-kids';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h), canGoBack: () => false },
  useFocusEffect: () => {},
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const mockStart = jest.fn(async (..._a: unknown[]) => true);
jest.mock('@/components/player/start-book', () => ({
  startBookInPlace: (...a: unknown[]) => mockStart(...a),
}));
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
// The player has its own suite; here only whether the screen shows it.
jest.mock('./kids-player', () => ({
  KidsPlayer: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>kids player</Text>;
  },
}));
const mockToggle = jest.fn(async () => {});
let mockLoadedKey: string | null = null;
let mockLive = false;
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({ nowPlaying: null, toggle: () => mockToggle() })),
    selectBookKey: () => mockLoadedKey,
    selectIsPlaying: () => false,
    selectIsTransportLive: () => mockLive,
  };
});
let mockStories: KidsStories = { status: 'loading' };
const mockRetry = jest.fn();
jest.mock('./use-kids', () => ({
  useKidsProfile: () => ({
    id: 'p',
    name: 'Leo',
    connectionIds: ['c'],
    kids: { bedtime: '19:30' },
  }),
  useKidsStories: () => ({
    stories: mockStories,
    connectionId: 'c',
    library: null,
    retry: mockRetry,
    loadMore: jest.fn(),
  }),
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));

/* eslint-disable import/first */
import { toast } from '@/components/ui/toast';
import { contentKey } from '@/lib/content-key';
import { formatTimeOfDay } from '@/lib/format';
import { useSleepTimer } from '@/playback/sleep-timer';
import { usePlayer } from '@/playback/store';

import { HOLD_MS } from './grown-ups-button';
import { KidsScreen } from './kids-screen';
/* eslint-enable import/first */

const book = (path: string, title = path): Book =>
  ({ id: 0, library_id: 3, rel_path: path, title, author: '' }) as Book;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 9, 10, 15, 0));
  jest.clearAllMocks();
  mockStories = { status: 'loading' };
  mockLayout = 'phone';
  mockLoadedKey = null;
  mockLive = false;
});
afterEach(() => {
  jest.useRealTimers();
  usePlayer.setState({ nowPlaying: null });
});

it('greets the child and says when bedtime is', async () => {
  await render(<KidsScreen />);
  expect(screen.getByText('Hi Leo')).toBeTruthy();
  const moon = screen.getByTestId('kids-moon-card');
  // In the reader's clock convention (`formatTimeOfDay`).
  expect(within(moon).getByText(`Bedtime is at ${formatTimeOfDay('19:30')}`)).toBeTruthy();
  expect(within(moon).getByText(/After bedtime, a story stops by itself/)).toBeTruthy();
});

it('says the sleep timer comes on, inside the bedtime window', async () => {
  jest.setSystemTime(new Date(2026, 9, 10, 20, 15));
  await render(<KidsScreen />);
  // It is bedtime now: not "Bedtime is at 7:30 PM" in the middle of the night.
  expect(screen.getByText("It's bedtime")).toBeTruthy();
  expect(screen.queryByText(/Bedtime is at/)).toBeNull();
  expect(screen.getByText('Sleep timer comes on when a story starts')).toBeTruthy();
});

it('says the sleep timer is on, with its minutes left, while it runs', async () => {
  jest.setSystemTime(new Date(2026, 9, 11, 2, 5));
  useSleepTimer.setState({
    phase: 'running',
    endsAt: Date.now() + 12 * 60_000 + 10_000,
    remaining: 12 * 60 + 10,
  });
  try {
    await render(<KidsScreen />);
    expect(screen.getByText("It's bedtime")).toBeTruthy();
    expect(screen.getByText('Sleep timer on, 13 minutes left')).toBeTruthy();
  } finally {
    await act(async () => useSleepTimer.setState({ phase: 'idle', endsAt: null, remaining: null }));
  }
});

it('starts a story in place when its tile is tapped, never opening the full player', async () => {
  mockStories = {
    status: 'ready',
    books: [book('kids/b', 'B'), book('kids/a', 'A')],
    offline: false,
    more: 'none',
  };
  await render(<KidsScreen />);
  const tiles = screen.getAllByRole('button', { name: /^Play / });
  expect(tiles.map((t) => t.props.accessibilityLabel)).toEqual(['Play B', 'Play A']);
  await fireEvent.press(screen.getByRole('button', { name: 'Play A' }));
  expect(mockStart).toHaveBeenCalledWith({ connectionId: 'c', libraryId: 3, path: 'kids/a' });
  // Kids mode is its own player: on a phone too, nothing pushes /player.
  expect(mockPush).not.toHaveBeenCalled();
});

it('plays the loaded story on rather than starting it again', async () => {
  mockStories = { status: 'ready', books: [book('kids/a', 'A')], offline: false, more: 'none' };
  mockLoadedKey = contentKey('c', 3, 'kids/a');
  await render(<KidsScreen />);
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Play A' })));
  expect(mockToggle).toHaveBeenCalledTimes(1);
  expect(mockStart).not.toHaveBeenCalled();

  // Already playing: a tap leaves it playing.
  mockLive = true;
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Play A' })));
  expect(mockToggle).toHaveBeenCalledTimes(1);
});

it('says so when a story will not start', async () => {
  mockStories = { status: 'ready', books: [book('kids/a', 'A')], offline: false, more: 'none' };
  mockStart.mockRejectedValueOnce(new Error('gone'));
  await render(<KidsScreen />);
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Play A' })));
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "That story won't start right now" }),
  );
});

it('shows the big player only while a story is loaded', async () => {
  await render(<KidsScreen />);
  expect(screen.queryByText('kids player')).toBeNull();
  await act(async () => usePlayer.setState({ nowPlaying: { title: 'x' } as never }));
  expect(screen.getByText('kids player')).toBeTruthy();
});

it('has loading, empty, error and offline states', async () => {
  const view = await render(<KidsScreen />);
  expect(screen.getByTestId('kids-loading')).toBeTruthy();

  mockStories = { status: 'empty', serverName: 'Hearthside' };
  await view.rerender(<KidsScreen />);
  expect(screen.getByText('No stories here yet')).toBeTruthy();
  expect(screen.getByText('Ask a grown-up to add some on Hearthside.')).toBeTruthy();

  mockStories = { status: 'error', serverName: 'Hearthside', offline: true };
  await view.rerender(<KidsScreen />);
  expect(
    screen.getByText("Hearthside can't be reached and there are no stories saved on this device."),
  ).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(mockRetry).toHaveBeenCalled();

  mockStories = { status: 'ready', books: [book('saved')], offline: true, more: 'none' };
  await view.rerender(<KidsScreen />);
  expect(screen.getByTestId('kids-offline-note')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Play saved' })).toBeTruthy();
});

it('goes to "Who\'s listening?" after a grown-up holds for 2 seconds', async () => {
  await render(<KidsScreen />);
  await fireEvent(screen.getByTestId('kids-grown-ups'), 'pressIn');
  await act(async () => void jest.advanceTimersByTime(HOLD_MS));
  expect(mockPush).toHaveBeenCalledWith('/profiles');
});

it('offers no way into search, settings or downloads', async () => {
  mockStories = { status: 'ready', books: [book('kids/a', 'A')], offline: false, more: 'none' };
  await render(<KidsScreen />);
  const labels = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
  expect(labels).toEqual(['Grown-ups', 'Play A']);
});

it('asks again under the grid when a further page of stories failed', async () => {
  mockStories = { status: 'ready', books: [book('kids/a', 'A')], offline: false, more: 'failed' };
  await render(<KidsScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(mockRetry).toHaveBeenCalled();

  mockStories = { status: 'ready', books: [book('kids/a', 'A')], offline: false, more: 'loading' };
  await render(<KidsScreen />);
  expect(screen.getByTestId('kids-more-loading')).toBeTruthy();
});

it('lays the stories out in rows by the measured width, at most 1200 wide', async () => {
  mockLayout = 'desktop';
  mockStories = {
    status: 'ready',
    books: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((p) => book(`kids/${p}`, p)),
    offline: false,
    more: 'none',
  };
  await render(<KidsScreen />);
  await fireEvent(screen.getByTestId('kids-page'), 'layout', {
    nativeEvent: { layout: { width: 1600, height: 900 } },
  });
  // 1200 wide (1600 less the 36 gutters, capped): six 180 tiles with five 24 gaps.
  const widths = screen
    .getAllByRole('button', { name: /^Play / })
    .map((b) => StyleSheet.flatten(b.props.style)?.width);
  expect(new Set(widths)).toEqual(new Set([180]));
  expect(widths).toHaveLength(7);
});

it("offers the kid's own sign-in again when its token is dead (the shell's banner is not here)", async () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { useSession } = require('@/stores/session') as typeof import('@/stores/session');
  const { useProfiles } = require('@/stores/profiles') as typeof import('@/stores/profiles');
  /* eslint-enable @typescript-eslint/no-require-imports */
  useProfiles.setState({
    hydrated: true,
    activeProfileId: 'p',
    profiles: [{ id: 'p', name: 'Leo', connectionIds: ['c'], kids: { bedtime: '19:30' } }],
  });
  useSession.setState({
    connections: [
      {
        id: 'c',
        serverUrl: 'https://kids.example',
        name: 'Story Box',
        token: 't',
        user: { id: 1, username: 'leo' } as never,
        needsReconnect: 'auth',
      },
    ],
  });
  try {
    await render(<KidsScreen />);
    await fireEvent.press(screen.getByText(/Story Box/));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/connect/sign-in',
      params: { serverName: 'Story Box', reconnect: 'c' },
    });
  } finally {
    useSession.setState({ connections: [] });
    useProfiles.setState({ profiles: [], activeProfileId: null });
  }
});
