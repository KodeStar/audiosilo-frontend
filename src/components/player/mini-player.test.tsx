import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { PlayerStoreMock } from '@/testing/player-store-mock';

const mockPush = jest.fn();
let mockSegments = ['(app)'];
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a) },
  useSegments: () => mockSegments,
}));
jest.mock('@/lib/layout', () => ({ useLayout: () => 'phone' }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/shell/accessory-support', () => ({ ACCESSORY_SUPPORTED: false }));
jest.mock('@/playback/store', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ...require('@/testing/player-store-mock').createPlayerStoreMock(),
  selectCurrentChapter: (s: { chapter?: unknown }) => s.chapter ?? null,
}));
// The cover reads the server; its own suite covers it.
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));

/* eslint-disable import/first */
import { useShellMetrics } from '@/components/shell/shell-metrics';
import { useSleepTimer } from '@/playback/sleep-timer';
import { useSettings } from '@/stores/settings';
import { playerStoreMock } from '@/testing/player-store-mock';

import { selectChapterFraction } from './chapter-progress';
import {
  FloatingMiniPlayer,
  MINI_PLAYER_GAP,
  MINI_PLAYER_HEIGHT,
  MiniPlayer,
  useMiniPlayerInset,
} from './mini-player';
/* eslint-enable import/first */

const CHAPTER = { index: 22, title: 'Bridge Four', book_offset: 600, start: 600, end: 1200 };
const BOOK = {
  connectionId: 'c1',
  libraryId: 1,
  path: 'A/B',
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
  cover: '',
  queue: { total: 3600, chapters: [CHAPTER], offsets: [0] },
};
let player: PlayerStoreMock;
const retry = jest.fn(() => Promise.resolve());
const skipSeconds = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockSegments = ['(app)'];
  player = playerStoreMock();
  player.reset();
  player.usePlayer.setState({
    nowPlaying: BOOK,
    chapter: CHAPTER,
    bookPosition: 900,
    rate: 1.25,
    retry,
    skipSeconds,
  } as never);
  useSettings.setState({ skipBackward: 15 });
  useSleepTimer.setState({ phase: 'idle', remaining: null });
  useShellMetrics.setState({ edges: {} });
});

describe('MiniPlayer', () => {
  it('shows the chapter, then the book and its time left at the listening speed', async () => {
    await render(<MiniPlayer />);
    expect(screen.getByText('Bridge Four')).toBeTruthy();
    // (3600 - 900) / 1.25 = 2160 s.
    expect(screen.getByText('The Way of Kings · 36m left at 1.25×')).toBeTruthy();
    expect(screen.queryByTestId('mini-sleep')).toBeNull();
  });

  it('puts the sleep countdown first while a timer runs', async () => {
    await render(<MiniPlayer />);
    await act(async () => useSleepTimer.setState({ phase: 'running', remaining: 724 }));
    expect(screen.getByTestId('mini-sleep')).toHaveTextContent('12:04 ·');
    expect(screen.getByText('The Way of Kings · 36m left at 1.25×')).toBeTruthy();
    // Not in the grace window (a paused book is no countdown).
    await act(async () => useSleepTimer.setState({ phase: 'grace', remaining: 20 }));
    expect(screen.queryByTestId('mini-sleep')).toBeNull();
  });

  it('names a chapterless book once: its title, then the time left', async () => {
    player.usePlayer.setState({ chapter: null } as never);
    await render(<MiniPlayer />);
    expect(screen.getByText('The Way of Kings')).toBeTruthy();
    expect(screen.getByText('36m left at 1.25×')).toBeTruthy();
  });

  it('offers Retry after a playback error, and skips back', async () => {
    player.setPlayState('error');
    await render(<MiniPlayer />);
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Back 15 seconds' }));
    expect(skipSeconds).toHaveBeenCalledWith(-15);
  });

  it('marks play busy while the book loads, and pauses while playing', async () => {
    player.setPlayState('loading');
    await render(<MiniPlayer />);
    expect(screen.getByRole('button', { name: 'Play' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ busy: true }),
    );
    await act(async () => player.setPlayState('playing'));
    await fireEvent.press(screen.getByRole('button', { name: 'Pause' }));
    expect(player.spies.toggle).toHaveBeenCalledTimes(1);
  });

  it('opens the full player from the cover and text', async () => {
    await render(<MiniPlayer />);
    await fireEvent.press(screen.getByLabelText('Open the full player for The Way of Kings'));
    expect(mockPush).toHaveBeenCalledWith('/player');
  });

  it('publishes its top edge (bar, gap and card) for the toasts, and withdraws it', async () => {
    useShellMetrics.setState({ edges: { bar: 80 } });
    await render(<FloatingMiniPlayer />);
    expect(useShellMetrics.getState().edges.mini).toBeUndefined();
    await fireEvent(screen.getByTestId('mini-player'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 384, height: MINI_PLAYER_HEIGHT } },
    });
    expect(useShellMetrics.getState().edges.mini).toBe(80 + MINI_PLAYER_GAP + MINI_PLAYER_HEIGHT);
    await screen.unmount();
    expect(useShellMetrics.getState().edges.mini).toBeUndefined();
  });

  it('waits for the native bar to be measured before it shows', async () => {
    await render(<FloatingMiniPlayer />);
    expect(screen.queryByTestId('mini-player-card')).toBeNull();
    await act(async () => useShellMetrics.setState({ edges: { bar: 64 } }));
    expect(screen.getByTestId('mini-player-card')).toBeTruthy();
  });

  it('stands down under the full player, and comes back after it', async () => {
    const view = await render(<MiniPlayer />);
    expect(screen.getByTestId('mini-player')).toBeTruthy();
    mockSegments = ['player'];
    await view.rerender(<MiniPlayer />);
    expect(screen.queryByTestId('mini-player')).toBeNull();
    mockSegments = ['(app)'];
    await view.rerender(<MiniPlayer />);
    expect(screen.getByTestId('mini-player')).toBeTruthy();
  });

  it('renders nothing with no book', async () => {
    player.usePlayer.setState({ nowPlaying: null } as never);
    await render(<MiniPlayer />);
    expect(screen.queryByTestId('mini-player-card')).toBeNull();
  });
});

describe('useMiniPlayerInset', () => {
  function Probe() {
    const inset = useMiniPlayerInset();
    const { Text } = jest.requireActual('react-native');
    return <Text>{`inset ${inset}`}</Text>;
  }

  it('reserves the card and its gap while a book is loaded', async () => {
    await render(<Probe />);
    expect(screen.getByText(`inset ${16 + MINI_PLAYER_HEIGHT + MINI_PLAYER_GAP}`)).toBeTruthy();
    await act(async () => player.usePlayer.setState({ nowPlaying: null } as never));
    expect(screen.getByText('inset 16')).toBeTruthy();
  });
});

describe('selectChapterFraction', () => {
  it('is how far through the current chapter the player is', () => {
    const s = player.usePlayer.getState();
    expect(selectChapterFraction(s as never)).toBe(0.5); // 900 in 600..1200
    expect(selectChapterFraction({ ...s, chapter: null } as never)).toBe(0.25); // 900 / 3600
    expect(selectChapterFraction({ ...s, nowPlaying: null } as never)).toBe(0);
  });
});
