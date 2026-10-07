import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useSegments: () => ['(app)'] }));
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
