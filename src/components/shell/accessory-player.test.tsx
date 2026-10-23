import { act, render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useSegments: () => ['(app)'],
  usePathname: () => '/',
}));
jest.mock('expo-router/unstable-native-tabs', () => ({
  NativeTabs: { BottomAccessory: { usePlacement: () => 'regular' } },
}));
jest.mock('@/lib/layout', () => ({ useLayout: () => 'phone' }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/playback/store', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ...require('@/testing/player-store-mock').createPlayerStoreMock(),
  selectCurrentChapter: () => null,
}));
// The cover reads the server; its own suite covers it.
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));

/* eslint-disable import/first */
import { useEpisodeFetch } from '@/playback/episode-fetch';
import { useSettings } from '@/stores/settings';
import { playerStoreMock } from '@/testing/player-store-mock';
import { expectNativeTarget } from '@/testing/touch-target';

import { AccessoryPlayer } from './accessory-player';
/* eslint-enable import/first */

beforeEach(() => {
  const player = playerStoreMock();
  player.reset();
  player.usePlayer.setState({
    nowPlaying: {
      connectionId: 'c1',
      libraryId: 1,
      path: 'A/B',
      title: 'The Way of Kings',
      queue: { total: 3600, chapters: [], offsets: [0] },
    },
    bookPosition: 900,
  } as never);
  useSettings.setState({ skipBackward: 15 });
});

// 2.5 rem is 35 pt on native (a 14 pt rem); the accessory's skip back needs its slop.
it('gives skip back a 44 pt target', async () => {
  await render(<AccessoryPlayer />);
  expectNativeTarget(screen.getByLabelText('Back 15 seconds'));
});

describe('an episode on its way (no room for the strip)', () => {
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

  it('is the pill when nothing plays: the episode, how it goes, Cancel', async () => {
    playerStoreMock().usePlayer.setState({ nowPlaying: null } as never);
    useEpisodeFetch.setState({ pending: PENDING });
    await render(<AccessoryPlayer />);
    expect(screen.getByTestId('accessory-fetch-regular')).toBeTruthy();
    expect(screen.getByText('Monday')).toBeTruthy();
    expect(screen.getByTestId('accessory-fetch-line')).toBeTruthy();
    expect(screen.getByLabelText('Stop getting Monday')).toBeTruthy();
    expect(screen.queryByLabelText('Back 15 seconds')).toBeNull();
  });

  it('offers Try again once it stopped', async () => {
    playerStoreMock().usePlayer.setState({ nowPlaying: null } as never);
    useEpisodeFetch.setState({ pending: { ...PENDING, phase: 'failed' as never } });
    await render(<AccessoryPlayer />);
    expect(screen.getByTestId('accessory-fetch-retry')).toBeTruthy();
    expect(screen.getByText("Couldn't get this episode")).toBeTruthy();
  });

  it('keeps the book playing on, with the fetch as its second line', async () => {
    useEpisodeFetch.setState({ pending: PENDING });
    await render(<AccessoryPlayer />);
    expect(screen.getByLabelText('Back 15 seconds')).toBeTruthy();
    expect(screen.getByTestId('accessory-fetch-line').props.children).toBe('Getting Monday');
  });

  it('shows nothing with neither a book nor a fetch', async () => {
    playerStoreMock().usePlayer.setState({ nowPlaying: null } as never);
    await render(<AccessoryPlayer />);
    expect(screen.queryByTestId('accessory-player-regular')).toBeNull();
  });
});
