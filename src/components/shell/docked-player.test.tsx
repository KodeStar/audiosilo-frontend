import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { PlayerStoreMock } from '@/testing/player-store-mock';

const mockPush = jest.fn();
let mockSegments = ['(app)'];
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a) },
  useSegments: () => mockSegments,
}));

let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({ useLayout: () => mockLayout }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/playback/store', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ...require('@/testing/player-store-mock').createPlayerStoreMock(),
  selectCurrentChapter: (s: { chapter?: unknown }) => s.chapter ?? null,
}));
// The cover, the scrubber and Up next have their own suites.
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/components/ui/slider', () => ({ Slider: () => null }));
jest.mock('@/components/upnext/up-next-button', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    UpNextButton: ({ variant }: { variant: string }) => <RNText>{`upnext-${variant}`}</RNText>,
  };
});
let mockBookmarks: number[] = [];
jest.mock('@/components/player/use-playing-pins', () => ({
  usePlayingPins: () => ({ bookmarks: mockBookmarks, notes: [] }),
}));
const mockAddBookmark = jest.fn(() => Promise.resolve());
jest.mock('@/components/player/player-shortcuts', () => ({
  addBookmarkHere: (...a: unknown[]) => mockAddBookmark(...(a as [])),
}));

/* eslint-disable import/first */
import { expectNativeTarget } from '@/testing/touch-target';
import { usePlayerSheets } from '@/components/player/player-sheets';
import { useReachability } from '@/api/reachability';
import { useEpisodeFetch } from '@/playback/episode-fetch';
import { UNDO_WINDOW_MS, useJumpUndo } from '@/playback/jump-undo';
import { useSleepTimer } from '@/playback/sleep-timer';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { playerStoreMock } from '@/testing/player-store-mock';

import { DockedPlayer, dockLayout } from './docked-player';
import { useShellMetrics } from './shell-metrics';
/* eslint-enable import/first */

const BOOK = {
  connectionId: 'c1',
  libraryId: 1,
  path: 'A/B',
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
  cover: 'https://x/cover',
  queue: { total: 3600, chapters: [], offsets: [0] },
};
let player: PlayerStoreMock;
const showRoutePicker = jest.fn(() => Promise.resolve());

beforeEach(() => {
  jest.clearAllMocks();
  mockLayout = 'desktop';
  mockSegments = ['(app)'];
  mockBookmarks = [];
  player = playerStoreMock();
  player.reset();
  player.usePlayer.setState({
    nowPlaying: BOOK,
    bookPosition: 30,
    rate: 1.25,
    canRoutePick: true,
    showRoutePicker,
    skipSeconds: jest.fn(),
    seekBook: jest.fn(),
    seekInTrack: jest.fn(),
  } as never);
  useSettings.setState({ skipForward: 30, skipBackward: 15 });
  useSleepTimer.setState({ phase: 'idle', remaining: null, label: null });
  useJumpUndo.setState({ jump: null });
  usePlayerSheets.setState({ open: null });
  useSession.setState({
    connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'u', token: 't', user: {} as never }],
  });
  useReachability.setState({ online: {} });
});

/** Render the dock and lay it out at `width`. */
async function renderAt(width: number) {
  await render(<DockedPlayer />);
  await fireEvent(screen.getByTestId('shell-docked-player'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width, height: 84 } },
  });
}

describe('dockLayout', () => {
  it('shows every action from 1024, the tablet set below, and drops the scrubber below 800', () => {
    expect(dockLayout(1440)).toEqual({ allActions: true, scrubber: true });
    expect(dockLayout(1024)).toEqual({ allActions: true, scrubber: true });
    expect(dockLayout(900)).toEqual({ allActions: false, scrubber: true });
    expect(dockLayout(700)).toEqual({ allActions: false, scrubber: false });
  });

  it("makes room for the Undo chip's measured width: the scrubber row first, then the secondary actions", () => {
    // A tablet (834): the scrubber row goes while the chip shows, so the book keeps its title.
    expect(dockLayout(834, 150)).toEqual({ allActions: false, scrubber: false });
    expect(dockLayout(834, 0)).toEqual({ allActions: false, scrubber: true });
    // A small desktop window: the secondary actions make way, the scrubber stays.
    expect(dockLayout(1024, 150)).toEqual({ allActions: false, scrubber: true });
    // A short chip in a wide enough window leaves everything; a long one does not.
    expect(dockLayout(1180, 150)).toEqual({ allActions: true, scrubber: true });
    expect(dockLayout(1180, 190)).toEqual({ allActions: false, scrubber: true });
    // A wide window has room for everything.
    expect(dockLayout(1440, 190)).toEqual({ allActions: true, scrubber: true });
  });
});

describe('DockedPlayer', () => {
  it('carries every action on a wide bar, all labelled', async () => {
    await renderAt(1280);
    for (const label of [
      'Previous chapter',
      'Back 15 seconds',
      'Play',
      'Forward 30 seconds',
      'Next chapter',
      'Playback speed, 1.25×',
      'Sleep timer',
      'Add a bookmark',
      'Audio output',
      'Expand player',
      'Open the full player for The Way of Kings',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByText('1.25×')).toBeTruthy();
    expect(screen.getByText('upnext-dock')).toBeTruthy();
    // No chapter: the heading is the title, so the line under it is the author alone.
    expect(screen.getByText('The Way of Kings')).toBeTruthy();
    expect(screen.getByText('Brandon Sanderson')).toBeTruthy();
    expect(screen.queryByText('The Way of Kings · Brandon Sanderson')).toBeNull();
  });

  it('keeps the book and author under a chapter heading', async () => {
    player.usePlayer.setState({ chapter: { title: 'Prologue', index: 0 } } as never);
    await renderAt(1280);
    expect(screen.getByText('Prologue')).toBeTruthy();
    expect(screen.getByText('The Way of Kings · Brandon Sanderson')).toBeTruthy();
  });

  it('names an episode once, then its show', async () => {
    player.usePlayer.setState({
      nowPlaying: { ...BOOK, title: 'Episode 12', author: 'LibriVox' },
    } as never);
    await renderAt(1280);
    expect(screen.getAllByText('Episode 12')).toHaveLength(1);
    expect(screen.getByText('LibriVox')).toBeTruthy();
    expect(screen.queryByText(/Episode 12 ·/)).toBeNull();
  });

  // The server gives a single-file episode or book ONE chapter named after it: no chapter.
  it('treats a lone chapter named after an episode as none', async () => {
    const lone = { title: 'Current generation', index: 0 };
    player.usePlayer.setState({
      nowPlaying: {
        ...BOOK,
        title: 'Current generation',
        author: 'Fixture Publisher',
        queue: { ...BOOK.queue, chapters: [lone] },
      },
      chapter: lone,
    } as never);
    await renderAt(1280);
    expect(screen.getAllByText('Current generation')).toHaveLength(1);
    expect(screen.getByText('Fixture Publisher')).toBeTruthy();
    expect(screen.queryByText(/Current generation ·/)).toBeNull();
  });

  it('treats a lone chapter named after a book as none, whatever its case and spacing', async () => {
    const lone = { title: '  the gift of the MAGI ', index: 0 };
    player.usePlayer.setState({
      nowPlaying: {
        ...BOOK,
        title: 'The Gift of the Magi',
        author: 'O. Henry',
        queue: { ...BOOK.queue, chapters: [lone] },
      },
      chapter: lone,
    } as never);
    await renderAt(1280);
    expect(screen.getByText('The Gift of the Magi')).toBeTruthy();
    expect(screen.queryByText(/MAGI/)).toBeNull();
    expect(screen.getByText('O. Henry')).toBeTruthy();
    expect(screen.queryByText('The Gift of the Magi · O. Henry')).toBeNull();
  });

  it('keeps a lone chapter named otherwise as the heading', async () => {
    const lone = { title: 'Prologue', index: 0 };
    player.usePlayer.setState({
      nowPlaying: { ...BOOK, queue: { ...BOOK.queue, chapters: [lone] } },
      chapter: lone,
    } as never);
    await renderAt(1280);
    expect(screen.getByText('Prologue')).toBeTruthy();
    expect(screen.getByText('The Way of Kings · Brandon Sanderson')).toBeTruthy();
  });

  it('keeps a chapter named after the book when the book has several', async () => {
    const first = { title: 'The Way of Kings', index: 0 };
    player.usePlayer.setState({
      nowPlaying: {
        ...BOOK,
        queue: { ...BOOK.queue, chapters: [first, { title: 'Prologue', index: 1 }] },
      },
      chapter: first,
    } as never);
    await renderAt(1280);
    expect(screen.getByText('The Way of Kings')).toBeTruthy();
    expect(screen.getByText('The Way of Kings · Brandon Sanderson')).toBeTruthy();
  });

  // 2.25 rem pills are 31.5 pt on native (a 14 pt rem): their slop makes up 44.
  it('gives its pills a 44 pt target on native', async () => {
    await renderAt(1280);
    for (const id of ['dock-speed', 'dock-bookmark', 'dock-output', 'dock-expand']) {
      expectNativeTarget(screen.getByTestId(id));
    }
  });

  it('shows output only where the engine can pick a route', async () => {
    player.usePlayer.setState({ canRoutePick: false } as never);
    await renderAt(1280);
    expect(screen.queryByTestId('dock-output')).toBeNull();
  });

  it('hides speed, bookmark and output at tablet widths, keeping sleep, Up next and expand', async () => {
    mockLayout = 'tablet';
    await renderAt(900);
    expect(screen.queryByTestId('dock-speed')).toBeNull();
    expect(screen.queryByTestId('dock-bookmark')).toBeNull();
    expect(screen.queryByTestId('dock-output')).toBeNull();
    expect(screen.getByTestId('dock-sleep')).toBeTruthy();
    expect(screen.getByText('upnext-dock')).toBeTruthy();
    expect(screen.getByTestId('dock-expand')).toBeTruthy();
    // The scrubber row (and its time left) still fits.
    expect(screen.getByText('47m left at 1.25×')).toBeTruthy();
  });

  it('drops the scrubber row on a narrow bar, keeping the transport', async () => {
    mockLayout = 'tablet';
    await renderAt(700);
    expect(screen.queryByText('47m left at 1.25×')).toBeNull();
    expect(screen.getByLabelText('Play')).toBeTruthy();
  });

  it('opens the speed and sleep sheets through the shared sheet store', async () => {
    await renderAt(1280);
    await fireEvent.press(screen.getByTestId('dock-speed'));
    expect(usePlayerSheets.getState().open).toBe('speed');
    await fireEvent.press(screen.getByLabelText('Sleep timer'));
    expect(usePlayerSheets.getState().open).toBe('sleep');
  });

  it('adds a bookmark here, picks an output, and expands to the full player', async () => {
    await renderAt(1280);
    await fireEvent.press(screen.getByTestId('dock-bookmark'));
    expect(mockAddBookmark).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('dock-output'));
    expect(showRoutePicker).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('dock-expand'));
    expect(mockPush).toHaveBeenCalledWith('/player');
    await fireEvent.press(screen.getByLabelText('Open the full player for The Way of Kings'));
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it('turns the sleep pill brand-soft with its countdown while a timer runs', async () => {
    await renderAt(1280);
    expect(screen.getByLabelText('Sleep timer').props.className).not.toContain('bg-brand-soft');
    await act(async () =>
      useSleepTimer.setState({
        phase: 'running',
        remaining: 724,
        label: { key: 'player.sleepTimer.minutes', params: { count: 15 } },
      }),
    );
    const pill = screen.getByLabelText('Sleep timer, 15 min, 12:04 left');
    expect(pill.props.className).toContain('bg-brand-soft');
    expect(screen.getByText('12:04')).toBeTruthy();
  });

  it('says "Keep going" in the grace window, labelled for what the sheet can do', async () => {
    useSleepTimer.setState({ phase: 'grace', remaining: 20 });
    await renderAt(1280);
    expect(screen.getByText('Keep going')).toBeTruthy();
    expect(screen.getByLabelText('Keep listening')).toBeTruthy();
  });

  it('shows the Undo chip only after a jump in this book', async () => {
    await renderAt(1280);
    expect(screen.queryByLabelText(/^Back to /)).toBeNull();
    await act(async () =>
      useJumpUndo.setState({
        jump: {
          from: 62_810,
          bookKey: 'c1:1:A/B',
          at: Date.now(),
          until: Date.now() + UNDO_WINDOW_MS,
        },
      }),
    );
    expect(screen.getByLabelText('Back to 17:26:50')).toBeTruthy();
  });

  it('on a tablet the Undo chip takes the scrubber row, so the book keeps its room', async () => {
    mockLayout = 'tablet';
    await renderAt(834);
    expect(screen.getByText('47m left at 1.25×')).toBeTruthy();
    await act(async () =>
      useJumpUndo.setState({
        jump: { from: 62_810, bookKey: 'c1:1:A/B', at: Date.now(), until: Date.now() + 10_000 },
      }),
    );
    expect(screen.getByLabelText('Back to 17:26:50')).toBeTruthy();
    // Once it has laid out, its measured width comes off the bar's.
    await fireEvent(screen.getByTestId('undo-chip'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 170, height: 34 } },
    });
    expect(screen.queryByText('47m left at 1.25×')).toBeNull();
    expect(screen.getByLabelText('Play')).toBeTruthy();
    // ...and the right cluster stops sharing the slack, which goes to the book.
    expect(screen.getByTestId('dock-actions').props.className).toContain('grow-0');
    // The chip's ten seconds are up: the scrubber row comes back.
    await act(async () => useJumpUndo.setState({ jump: null }));
    expect(screen.getByText('47m left at 1.25×')).toBeTruthy();
  });

  it('renders nothing under the full player (its leaves would redraw behind it)', async () => {
    mockSegments = ['player'];
    await render(<DockedPlayer />);
    expect(screen.queryByTestId('shell-docked-player')).toBeNull();
  });

  it('ticks the bookmarks in the current segment over the scrubber', async () => {
    mockBookmarks = [100, 1800, 5000];
    await renderAt(1280);
    // No chapters: the segment is the whole book (3600 s), so 5000 is outside it.
    expect(
      screen.getAllByTestId('dock-bookmark-tick', { includeHiddenElements: true }),
    ).toHaveLength(2);
  });

  it('says where the place lives, truthfully', async () => {
    await renderAt(1280);
    expect(screen.getByText('Synced')).toBeTruthy();
    await act(async () => player.setPlayState('playing'));
    expect(screen.getByText('Synced just now')).toBeTruthy();
    await act(async () => useReachability.setState({ online: { c1: false } }));
    expect(screen.getByText('Saved on this device, will sync')).toBeTruthy();
    await act(async () =>
      useSession.setState({
        connections: [
          {
            id: 'c1',
            name: 'Hearthside',
            serverUrl: 'u',
            token: 't',
            user: {} as never,
            needsReconnect: 'auth',
          },
        ],
      }),
    );
    expect(screen.getByText('Saved on this device, sign in again to sync')).toBeTruthy();
    // A download playing on after its server was removed: no claim either way.
    await act(async () => useSession.setState({ connections: [] }));
    expect(screen.queryByTestId('dock-sync-state')).toBeNull();
  });

  it('publishes its measured top edge for the toasts, and withdraws it on unmount', async () => {
    await render(<DockedPlayer />);
    await fireEvent(screen.getByTestId('shell-docked-player'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 1024, height: 105 } },
    });
    expect(useShellMetrics.getState().edges.dock).toBe(105);
    await screen.unmount();
    expect(useShellMetrics.getState().edges.dock).toBeUndefined();
  });

  // Bridge Phase 2d-1: an episode fetched while another book plays on (decision 6.4).
  describe('while an episode is fetched', () => {
    const PENDING = {
      key: 'c1:5:Show/Ep.mp3',
      target: { connectionId: 'c1', libraryId: 5, path: 'Show/Ep.mp3' },
      title: 'Monday',
      show: 'Daily News',
      opts: {},
      phase: 'waiting' as const,
      status: null,
      code: null,
    };
    afterEach(async () => {
      await act(async () => useEpisodeFetch.setState({ pending: null }));
    });

    it('shows the fetch strip over the playing book', async () => {
      useEpisodeFetch.setState({ pending: PENDING });
      await renderAt(1280);
      expect(screen.getByTestId('episode-fetch-strip')).toBeTruthy();
      expect(screen.getByText('Monday')).toBeTruthy();
      expect(screen.getByLabelText('Previous chapter')).toBeTruthy();
    });

    it('is the whole bar when nothing is loaded, and gone once it ends', async () => {
      player.usePlayer.setState({ nowPlaying: null } as never);
      useEpisodeFetch.setState({ pending: PENDING });
      await render(<DockedPlayer />);
      expect(screen.getByTestId('episode-fetch-strip')).toBeTruthy();
      expect(screen.queryByLabelText('Previous chapter')).toBeNull();
      await act(async () => useEpisodeFetch.setState({ pending: null }));
      expect(screen.queryByTestId('shell-docked-player')).toBeNull();
    });
  });
});
