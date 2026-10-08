import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, Text, View } from 'react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

// --- router -------------------------------------------------------------------------
let mockSegments: string[] = ['(app)', '(home)'];
let mockPathname = '/';
const mockDispatch = jest.fn();
const mockRouter = {
  navigate: jest.fn(),
  push: jest.fn(),
  back: jest.fn(),
  canGoBack: () => true,
};
const mockPopTabToRoot = jest.fn();
jest.mock('@/lib/root-stack', () => ({
  ...jest.requireActual('@/lib/root-stack'),
  popTabToRoot: (tab: string) => mockPopTabToRoot(tab),
}));
jest.mock('expo-router', () => ({
  useSegments: () => mockSegments,
  usePathname: () => mockPathname,
  useNavigationContainerRef: () => ({ dispatch: mockDispatch }),
  // A getter: the factory runs while the imports below load, before `mockRouter` exists.
  get router() {
    return mockRouter;
  },
}));

let mockPlacement: 'regular' | 'inline' = 'regular';
jest.mock('expo-router/unstable-native-tabs', () => ({
  NativeTabs: { BottomAccessory: { usePlacement: () => mockPlacement } },
}));

let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({ useLayout: () => mockLayout }));

jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } = jest.requireActual('react-native');
  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: RNView,
  };
});

jest.mock('@/downloads/engine', () => ({ engine: { supported: true } }));
// theme-provider side-effect-imports global.css (unparseable in Node).
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'light', pref: 'light', setPref: jest.fn() }),
}));
jest.mock('@/api/provider', () => ({ useApi: () => ({ authHeaders: () => ({}) }) }));
// The cover and the bookmark ticks read the server; their own suites cover them.
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/components/player/use-playing-pins', () => ({
  usePlayingPins: () => ({ bookmarks: [], notes: [] }),
}));

// --- player ---------------------------------------------------------------------------
type MockPlayer = {
  nowPlaying: null | {
    connectionId: string;
    libraryId: number;
    path: string;
    title: string;
    author: string;
    cover: string;
    queue: { total: number; chapters: { book_offset: number }[]; offsets: number[] };
  };
  snapshot: { state: string; trackIndex: number; position: number; duration: number };
  rate: number;
  toggle: jest.Mock;
  retry: jest.Mock;
  skipSeconds: jest.Mock;
  seekBook: jest.Mock;
  seekInTrack: jest.Mock;
  goToTrack: jest.Mock;
};
jest.mock('@/playback/store', () => {
  const { create: createStore } = jest.requireActual('zustand');
  const usePlayer = createStore(() => ({
    nowPlaying: null,
    snapshot: { state: 'paused', trackIndex: 0, position: 0, duration: 0 },
    rate: 1,
    toggle: jest.fn(),
    retry: jest.fn(),
    skipSeconds: jest.fn(),
    seekBook: jest.fn(),
    seekInTrack: jest.fn(),
    goToTrack: jest.fn(),
  }));
  return {
    usePlayer,
    selectBookPosition: () => 30,
    selectCurrentChapter: () => null,
    selectIsPlaying: (s: MockPlayer) => s.snapshot.state === 'playing',
  };
});

// The scrubber has its own suite; stub it here.
jest.mock('@/components/ui/slider', () => ({ Slider: () => null }));
// The Up next entry point has its own suite (upnext/up-next-button.test.tsx).
jest.mock('@/components/upnext/up-next-button', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    UpNextButton: ({ variant }: { variant: string }) => <RNText>{`upnext-${variant}`}</RNText>,
  };
});

/* eslint-disable import/first */
import { useSleepTimer } from '@/playback/sleep-timer';
import { usePlayer } from '@/playback/store';
import { useSearchStore } from '@/stores/search';
import { useSession } from '@/stores/session';

import { AccessoryPlayer } from './accessory-player';
import { DockedPlayer } from './docked-player';
import { usePalette } from './palette-store';
import { PhoneTabBar } from './phone-tab-bar';
import { useShellMetrics } from './shell-metrics';
import { TopBar } from './top-bar';
/* eslint-enable import/first */

const player = usePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;

const book = {
  connectionId: 'c1',
  libraryId: 1,
  path: 'A/B',
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
  cover: 'https://x/cover',
  queue: { total: 3600, chapters: [{ book_offset: 0 }, { book_offset: 600 }], offsets: [0] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSegments = ['(app)', '(home)'];
  mockLayout = 'desktop';
  player.setState({
    nowPlaying: null,
    snapshot: { state: 'paused', trackIndex: 0, position: 0, duration: 0 },
  });
});

describe('PhoneTabBar', () => {
  it('labels the five destinations and marks the active one selected', async () => {
    mockSegments = ['(app)', '(library)', 'book', '[libraryId]'];
    await render(<PhoneTabBar />);
    for (const label of ['Home', 'Library', 'Search', 'Downloads', 'Me']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText('Library')).toBeSelected();
    expect(screen.getByLabelText('Home')).not.toBeSelected();
  });

  it('jumps to another tab (keeping its stack) and pops the active one to its root', async () => {
    await render(<PhoneTabBar />);
    await fireEvent.press(screen.getByLabelText('Search'));
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'JUMP_TO',
      payload: { name: '(search)' },
    });
    // Home is the active tab: pressing it pops its stack to the root.
    await fireEvent.press(screen.getByLabelText('Home'));
    expect(mockPopTabToRoot).toHaveBeenCalledWith('(home)');
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });
});

describe('TopBar', () => {
  beforeEach(() => {
    useSession.setState({
      connections: [
        { id: 'c1', name: 'Hearthside', serverUrl: 'u', token: 't', user: {} as never },
        { id: 'c2', name: "Maya's Shelf", serverUrl: 'v', token: 't', user: {} as never },
      ],
      defaultConnectionId: 'c1',
      user: { username: 'chris' } as never,
    });
  });

  it('lists Home, Library, Downloads and You, with the server line', async () => {
    await render(<TopBar />);
    expect(screen.getByTestId('top-bar-(home)')).toBeSelected();
    expect(screen.getByTestId('top-bar-(library)')).not.toBeSelected();
    expect(screen.getByTestId('top-bar-(library)')).toBeTruthy();
    expect(screen.getByTestId('top-bar-(offline)')).toBeTruthy();
    // The phone's "Me" tab is the top bar's "You".
    expect(screen.getByTestId('top-bar-(me)')).toHaveProp('accessibilityLabel', 'You');
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.queryByTestId('top-bar-(search)')).toBeNull();
    expect(screen.getByText('Hearthside + 1 more')).toBeTruthy();
    expect(screen.getByText('chris')).toBeTruthy();
    expect(screen.getByText('upnext-bar')).toBeTruthy();
  });

  it('drops the destination labels on a tablet', async () => {
    mockLayout = 'tablet';
    await render(<TopBar />);
    expect(screen.getByLabelText('Library')).toBeTruthy();
    expect(screen.queryByText('Library')).toBeNull();
  });

  it('opens the command palette from the omnisearch on web', async () => {
    const prevOS = Platform.OS;
    Platform.OS = 'web';
    try {
      usePalette.setState({ open: false });
      await render(<TopBar />);
      await fireEvent.press(screen.getByTestId('top-bar-search'));
      expect(usePalette.getState().open).toBe(true);
      expect(mockDispatch).not.toHaveBeenCalled();
    } finally {
      Platform.OS = prevOS;
      usePalette.setState({ open: false });
    }
  });

  it('jumps to Search and asks it to focus from the omnisearch on a native tablet', async () => {
    const before = useSearchStore.getState().focusRequest;
    await render(<TopBar />);
    await fireEvent.press(screen.getByTestId('top-bar-search'));
    expect(useSearchStore.getState().focusRequest).toBe(before + 1);
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'JUMP_TO',
      payload: { name: '(search)' },
    });
  });

  it("marks settings as the current page with aria-current, not a tab's aria-selected", async () => {
    // Settings is a page of whichever tab pushed it: the tab stays the selected one.
    mockSegments = ['(app)', '(library)', 'settings'];
    mockPathname = '/settings';
    await render(<TopBar />);
    const settings = screen.getByTestId('top-bar-settings');
    expect(settings).toHaveProp('aria-current', 'page');
    expect(settings.props['aria-selected']).toBeUndefined();
    expect(screen.getByTestId('top-bar-(library)')).toBeSelected();
    mockSegments = ['(app)', '(me)'];
    mockPathname = '/you';
    await render(<TopBar />);
    expect(screen.getByTestId('top-bar-settings').props['aria-current']).toBeUndefined();
    expect(screen.getByTestId('top-bar-(me)')).toBeSelected();
    mockSegments = ['(app)', '(home)'];
    mockPathname = '/';
  });

  it('opens settings on the current tab, and names the profile menu after the user', async () => {
    await render(<TopBar />);
    await fireEvent.press(screen.getByLabelText('Settings'));
    expect(mockRouter.push).toHaveBeenCalledWith('/settings');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('top-bar-profile')).toHaveProp(
      'accessibilityLabel',
      'Servers and account, chris',
    );
  });
});

describe('DockedPlayer', () => {
  it('renders nothing until a book is loaded', async () => {
    await render(
      <View>
        <DockedPlayer />
        <Text>page</Text>
      </View>,
    );
    expect(screen.queryByTestId('shell-docked-player')).toBeNull();
  });

  it('publishes its measured top edge for the toasts, and withdraws it on unmount', async () => {
    player.setState({ nowPlaying: book });
    await render(<DockedPlayer />);
    await fireEvent(screen.getByTestId('shell-docked-player'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 1024, height: 105 } },
    });
    expect(useShellMetrics.getState().edges.dock).toBe(105);
    await screen.unmount();
    expect(useShellMetrics.getState().edges.dock).toBeUndefined();
  });

  it('carries the labelled transport once a book is loaded', async () => {
    player.setState({ nowPlaying: book });
    await render(<DockedPlayer />);
    expect(screen.getByTestId('shell-docked-player')).toBeTruthy();
    for (const label of [
      'Previous chapter',
      'Back 15 seconds',
      'Play',
      'Forward 30 seconds',
      'Next chapter',
      'Expand player',
      'Open the full player for The Way of Kings',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByText('The Way of Kings · Brandon Sanderson')).toBeTruthy();
    expect(screen.getByText('upnext-dock')).toBeTruthy();
  });

  it('says the time left in the book at the listening speed (frontend#50)', async () => {
    player.setState({ nowPlaying: book, rate: 1.25 });
    await render(<DockedPlayer />);
    // (3600 - 30) / 1.25 = 2856 s.
    expect(screen.getByText('47m left at 1.25×')).toBeTruthy();
  });

  it('plays, skips by chapter and expands to the full player', async () => {
    player.setState({ nowPlaying: book });
    await render(<DockedPlayer />);
    await fireEvent.press(screen.getByLabelText('Play'));
    expect(player.getState().toggle).toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('Next chapter'));
    expect(player.getState().seekBook).toHaveBeenCalledWith(600);
    await fireEvent.press(screen.getByLabelText('Expand player'));
    expect(mockRouter.push).toHaveBeenCalledWith('/player');
  });
});

describe('AccessoryPlayer', () => {
  beforeEach(() => {
    mockLayout = 'phone';
  });

  it('is a pure function of the store and its placement', async () => {
    player.setState({
      nowPlaying: book,
      snapshot: { state: 'playing', trackIndex: 0, position: 0, duration: 0 },
    });
    mockPlacement = 'regular';
    await render(<AccessoryPlayer />);
    expect(screen.getByTestId('accessory-player-regular')).toBeTruthy();
    expect(screen.getByLabelText('Pause')).toBeTruthy();
    expect(screen.getByLabelText('Back 15 seconds')).toBeTruthy();
    await screen.unmount();

    mockPlacement = 'inline';
    await render(<AccessoryPlayer />);
    expect(screen.getByTestId('accessory-player-inline')).toBeTruthy();
    // The minimised pill keeps play/pause only.
    expect(screen.queryByLabelText('Back 15 seconds')).toBeNull();
    expect(screen.getByLabelText('Pause')).toBeTruthy();
  });

  it('puts the sleep countdown first, with the chapter line, in the regular pill only', async () => {
    player.setState({ nowPlaying: book });
    useSleepTimer.setState({ phase: 'running', remaining: 724 });
    try {
      mockPlacement = 'regular';
      await render(<AccessoryPlayer />);
      expect(screen.getByTestId('mini-sleep')).toHaveTextContent('12:04 ·');
      expect(
        screen.getByTestId('chapter-progress-fill', { includeHiddenElements: true }),
      ).toBeTruthy();
      await screen.unmount();

      // The inline pill beside the minimised bar is narrow: cover, heading, play.
      mockPlacement = 'inline';
      await render(<AccessoryPlayer />);
      expect(screen.getByText('The Way of Kings')).toBeTruthy();
      expect(screen.queryByTestId('mini-sleep')).toBeNull();
      expect(
        screen.queryByTestId('chapter-progress-fill', { includeHiddenElements: true }),
      ).toBeNull();
    } finally {
      useSleepTimer.setState({ phase: 'idle', remaining: null });
    }
  });

  it('offers Retry after a playback error', async () => {
    player.setState({
      nowPlaying: book,
      snapshot: { state: 'error', trackIndex: 0, position: 0, duration: 0 },
    });
    mockPlacement = 'inline';
    await render(<AccessoryPlayer />);
    await fireEvent.press(screen.getByLabelText('Retry'));
    expect(player.getState().retry).toHaveBeenCalled();
  });

  it('renders nothing with no book', async () => {
    mockPlacement = 'regular';
    await render(<AccessoryPlayer />);
    expect(screen.queryByTestId('accessory-player-regular')).toBeNull();
  });

  it('renders nothing on tablet and desktop, where the bar (and its accessory) is hidden', async () => {
    player.setState({ nowPlaying: book });
    mockPlacement = 'regular';
    mockLayout = 'tablet';
    await render(<AccessoryPlayer />);
    expect(screen.queryByTestId('accessory-player-regular')).toBeNull();
  });
});
