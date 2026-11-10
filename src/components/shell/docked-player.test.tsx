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
    expect(dockLayout(1440)).toMatchObject({ allActions: true, scrubber: true });
    expect(dockLayout(1024)).toMatchObject({ allActions: true, scrubber: true });
    expect(dockLayout(900)).toMatchObject({ allActions: false, scrubber: true });
    expect(dockLayout(700)).toMatchObject({ allActions: false, scrubber: false });
  });

  it('sizes the middle column to leave the side columns room for their actions', () => {
    // 1280: 1280 - 64 (padding and gaps) - 2 x 330 = 556 for the transport and scrubber.
    expect(dockLayout(1280).centre).toBe(556);
    // Never wider than 560, never narrower than 300 while it has the scrubber.
    expect(dockLayout(1880).centre).toBe(560);
    expect(dockLayout(1024).centre).toBe(300);
    expect(dockLayout(834).centre).toBe(330);
    expect(dockLayout(800).centre).toBe(300);
    // No scrubber: the transport alone.
    expect(dockLayout(700).centre).toBe(228);
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

  /** The props that place the three columns and the scrubber row. */
  const geometry = () => ({
    row: screen.getByTestId('dock-row').props.style,
    book: screen.getByTestId('dock-book').props.className,
    centre: [
      screen.getByTestId('dock-centre').props.style,
      screen.getByTestId('dock-centre').props.className,
    ],
    actions: screen.getByTestId('dock-actions').props.className,
    scrubber: screen.queryByText('47m left at 1.25×') !== null,
  });

  it.each([834, 1280, 1880])(
    'at %i the Undo chip moves nothing in the bar: it floats above it (fe#244)',
    async (width) => {
      mockLayout = width >= 1024 ? 'desktop' : 'tablet';
      await renderAt(width);
      const before = geometry();
      expect(before.scrubber).toBe(true);
      await act(async () =>
        useJumpUndo.setState({
          jump: { from: 62_810, bookKey: 'c1:1:A/B', at: Date.now(), until: Date.now() + 10_000 },
        }),
      );
      expect(screen.getByLabelText('Back to 17:26:50')).toBeTruthy();
      expect(geometry()).toEqual(before);
      // The chip is in the band above the bar, not in a column.
      expect(screen.getByTestId('dock-undo').props.style).toMatchObject({ bottom: '100%' });
      expect(screen.getByTestId('dock-actions')).not.toContainElement(
        screen.getByTestId('undo-chip'),
      );
      // Its ten seconds are up: still nothing moved.
      await act(async () => useJumpUndo.setState({ jump: null }));
      expect(screen.queryByTestId('undo-chip')).toBeNull();
      expect(geometry()).toEqual(before);
    },
  );

  it('keeps the transport centred: the side columns flex equally from nothing', async () => {
    await renderAt(1280);
    // Equal side columns, and the same padding on both sides, put the middle on the centre.
    for (const id of ['dock-book', 'dock-actions']) {
      expect(screen.getByTestId(id).props.className).toEqual(
        expect.stringContaining('flex-1 basis-0'),
      );
      expect(screen.getByTestId(id).props.className).toContain('min-w-0');
    }
    // A basis of 0 still counts padding: the book's `p-1.5` is matched by the actions'.
    expect(screen.getByTestId('dock-book').props.className).toContain('p-1.5');
    expect(screen.getByTestId('dock-actions').props.className).toContain('px-1.5');
    expect(screen.getByTestId('dock-row').props.style).toMatchObject({ paddingHorizontal: 16 });
    expect(screen.getByTestId('dock-centre').props.style).toMatchObject({ width: 556 });
    expect(screen.getByTestId('dock-centre').props.className).toContain('shrink-0');
  });

  it('lifts the toasts over the Undo chip while it shows', async () => {
    await renderAt(1280);
    expect(useShellMetrics.getState().edges.dock).toBe(84);
    await act(async () =>
      useJumpUndo.setState({
        jump: { from: 62_810, bookKey: 'c1:1:A/B', at: Date.now(), until: Date.now() + 10_000 },
      }),
    );
    expect(useShellMetrics.getState().edges.dock).toBe(84 + 42);
    await act(async () => useJumpUndo.setState({ jump: null }));
    expect(useShellMetrics.getState().edges.dock).toBe(84);
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
