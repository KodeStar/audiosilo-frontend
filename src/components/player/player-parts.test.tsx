import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform } from 'react-native';

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
let mockOffline = false;
let mockPending = 0;
jest.mock('@/api/reachability', () => ({
  serverStatus: () => (mockOffline ? 'offline' : 'online'),
  useReachability: (sel: (s: { online: Record<string, boolean> }) => unknown) =>
    sel({ online: {} }),
}));
jest.mock('@/components/home/use-sync-pill', () => ({ usePendingSaves: () => mockPending }));
jest.mock('@/stores/session', () => ({
  useSession: (sel: (s: { connections: { id: string }[] }) => unknown) =>
    sel({ connections: [{ id: 'a' }] }),
  onConnectionRemoved: jest.fn(),
}));
jest.mock('@/api/hooks', () => ({
  useCapability: () => true,
  useLibrariesAll: () => ({ libraries: [] }),
}));
let mockUpNext: { supported: boolean | undefined; count: number } = { supported: true, count: 4 };
jest.mock('@/components/upnext/use-up-next', () => ({ useUpNextBadge: () => mockUpNext }));
const mockOpenUpNext = jest.fn();
jest.mock('@/components/upnext/up-next-store', () => ({ openUpNext: () => mockOpenUpNext() }));
const mockAddBookmark = jest.fn(async () => undefined);
jest.mock('./player-shortcuts', () => ({ addBookmarkHere: () => mockAddBookmark() }));
jest.mock('./undo-chip', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    UndoChip: () => <T>Back to 1:00:00</T>,
    useUndoVisible: jest.requireActual('./undo-chip').useUndoVisible,
  };
});

/* eslint-disable import/first */
import { useJumpUndo } from '@/playback/jump-undo';
import { usePlayer } from '@/playback/store';
import { useTimeSavedStore } from '@/playback/time-saved';
import { useSettings } from '@/stores/settings';
import { playerStoreMock } from '@/testing/player-store-mock';
import { mountWithPortal } from '@/testing/render-overlay';
import { expectNativeTarget } from '@/testing/touch-target';

import { CompanionChips, PlayerActions, PlayerHeader, PlayerStatusLine } from './player-parts';
import { usePlayerSheets } from './player-sheets';
/* eslint-enable import/first */

const BOOK = {
  connectionId: 'a',
  libraryId: 1,
  path: 'Corey/Calibans War',
  queue: { chapters: [], total: 9000 },
};

async function mount(ui: ReactElement) {
  await act(async () => {
    render(ui);
  });
}

beforeEach(() => {
  const player = playerStoreMock();
  player.reset();
  player.usePlayer.setState({
    nowPlaying: BOOK,
    bookPosition: 3600,
    rate: 1.25,
    canRoutePick: false,
  } as never);
  mockOffline = false;
  mockPending = 0;
  mockUpNext = { supported: true, count: 4 };
  useJumpUndo.setState({ jump: null });
  usePlayerSheets.setState({ open: null });
  mockAddBookmark.mockClear();
});

describe('PlayerStatusLine', () => {
  it('says the place is synced, how much is heard and the time left at the speed', async () => {
    await mount(<PlayerStatusLine />);
    expect(screen.getByText('Synced · 40% of the book · 1h 12m left at 1.25×')).toBeTruthy();
  });

  it('says the place is kept on the device while the server is offline or saves wait', async () => {
    mockOffline = true;
    await mount(<PlayerStatusLine />);
    expect(screen.getByText(/^Saved on this device, will sync · 40%/)).toBeTruthy();
  });

  it('counts queued saves as not synced yet', async () => {
    mockPending = 2;
    await mount(<PlayerStatusLine />);
    expect(screen.getByText(/^Saved on this device, will sync/)).toBeTruthy();
  });

  it('becomes the Undo chip while a jump can be undone', async () => {
    useJumpUndo.setState({
      jump: { bookKey: 'a:1:Corey/Calibans War', from: 3600, at: 1, until: Date.now() + 9000 },
    } as never);
    await mount(<PlayerStatusLine />);
    expect(screen.getByText('Back to 1:00:00')).toBeTruthy();
    expect(screen.queryByText(/Synced/)).toBeNull();
  });
});

// STYLEGUIDE section 14: 44 pt targets. A rem is 14 pt on iOS and Android, so the 2.75
// rem (`h-11`) buttons and pills were 38.5 pt there without their hit slop.
describe('touch targets on native', () => {
  it('gives the header buttons, the action pills and the companion chips 44 pt', async () => {
    usePlayer.setState({ canRoutePick: true });
    await mountWithPortal(
      <>
        <PlayerHeader onClose={jest.fn()} onChapters={jest.fn()} />
        <PlayerActions wide upNext />
        <CompanionChips />
      </>,
    );
    for (const label of [
      'Minimise player',
      'More',
      'Playback speed, 1.25×',
      'Add a bookmark',
      'AirPlay or Cast',
      "Who's who",
      'Chapters',
    ]) {
      expectNativeTarget(screen.getByLabelText(label));
    }
    expectNativeTarget(screen.getByTestId('player-upnext'));
  });
});

describe('PlayerActions', () => {
  it('opens the speed and sleep sheets and adds a bookmark in one tap', async () => {
    await mount(<PlayerActions wide upNext />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Playback speed, 1.25×'));
    });
    expect(usePlayerSheets.getState().open).toBe('speed');
    await act(async () => {
      fireEvent.press(screen.getByTestId('player-sleep'));
    });
    expect(usePlayerSheets.getState().open).toBe('sleep');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add a bookmark'));
    });
    expect(mockAddBookmark).toHaveBeenCalledTimes(1);
  });

  it('offers Up next with its count where asked and the server has a queue', async () => {
    await mount(<PlayerActions wide upNext />);
    expect(screen.getByText('4')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('player-upnext'));
    });
    expect(mockOpenUpNext).toHaveBeenCalled();
  });

  it('leaves out Up next on a desktop and on a server without a queue', async () => {
    await mount(<PlayerActions wide upNext={false} />);
    expect(screen.queryByTestId('player-upnext')).toBeNull();
    mockUpNext = { supported: false, count: 0 };
    await mount(<PlayerActions wide upNext />);
    expect(screen.queryByTestId('player-upnext')).toBeNull();
  });

  it('shows the output picker only where the device can pick one', async () => {
    await mount(<PlayerActions wide upNext />);
    expect(screen.queryByTestId('player-output')).toBeNull();
  });

  describe('the effects state', () => {
    const realOS = Platform.OS;
    beforeEach(() => {
      useSettings.setState({ smartSpeed: false, voiceBoost: false });
      useTimeSavedStore.setState({ lifetime: 0, books: {} });
    });
    afterEach(() => {
      Platform.OS = realOS;
    });

    it('is not there while both effects are off', async () => {
      await mount(<PlayerActions wide upNext />);
      expect(screen.queryByTestId('player-effects')).toBeNull();
    });

    it('reads the time Smart Speed saved and opens the speed sheet, where its switch is', async () => {
      Platform.OS = 'android'; // Smart Speed runs on Android only
      useSettings.setState({ smartSpeed: true });
      useTimeSavedStore.setState({ lifetime: 7860, books: {} });
      await mount(<PlayerActions wide upNext />);
      expect(screen.getByText('Saved 2h 11m')).toBeTruthy();
      await act(async () => {
        fireEvent.press(screen.getByLabelText('Smart speed and voice boost: Saved 2h 11m'));
      });
      expect(usePlayerSheets.getState().open).toBe('speed');
    });

    it('stays off the phone row, which is full', async () => {
      useSettings.setState({ voiceBoost: true });
      await mount(<PlayerActions wide={false} upNext />);
      expect(screen.queryByTestId('player-effects')).toBeNull();
    });
  });
});
