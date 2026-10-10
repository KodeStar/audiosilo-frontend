import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

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
const mockPlayBook = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/components/player/use-play-book', () => ({
  usePlayBook: () => mockPlayBook,
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
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({ nowPlaying: null })),
    selectBookKey: () => null,
    selectIsPlaying: () => false,
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
  }),
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));

/* eslint-disable import/first */
import { toast } from '@/components/ui/toast';
import { formatTimeOfDay } from '@/lib/format';
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
  expect(screen.getByText('Sleep timer comes on when a story starts')).toBeTruthy();
});

it('plays a story through the one play path when its tile is tapped', async () => {
  mockStories = {
    status: 'ready',
    books: [book('kids/b', 'B'), book('kids/a', 'A')],
    offline: false,
  };
  await render(<KidsScreen />);
  const tiles = screen.getAllByRole('button', { name: /^Play / });
  expect(tiles.map((t) => t.props.accessibilityLabel)).toEqual(['Play B', 'Play A']);
  await fireEvent.press(screen.getByRole('button', { name: 'Play A' }));
  expect(mockPlayBook).toHaveBeenCalledWith({ connectionId: 'c', libraryId: 3, path: 'kids/a' });
});

it('says so when a story will not start', async () => {
  mockStories = { status: 'ready', books: [book('kids/a', 'A')], offline: false };
  mockPlayBook.mockRejectedValueOnce(new Error('gone'));
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

  mockStories = { status: 'ready', books: [book('saved')], offline: true };
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
  mockStories = { status: 'ready', books: [book('kids/a', 'A')], offline: false };
  await render(<KidsScreen />);
  const labels = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
  expect(labels).toEqual(['Grown-ups', 'Play A']);
});
