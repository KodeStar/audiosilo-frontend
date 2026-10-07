import { act, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

let mockSegments: string[] = ['(app)'];
jest.mock('expo-router', () => ({ useSegments: () => mockSegments }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'phone',
}));
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  const usePlayer = create(() => ({
    nowPlaying: {
      title: 'Book',
      connectionId: 'a',
      libraryId: 1,
      path: 'p',
      queue: { total: 100 },
    },
    canRoutePick: true,
    showRoutePicker: jest.fn(async () => undefined),
  }));
  return { usePlayer };
});
const mockAddBookmark = jest.fn(async () => undefined);
jest.mock('./player-shortcuts', () => ({ addBookmarkHere: () => mockAddBookmark() }));
// Each sheet as a stand-in that says whether it is open.
jest.mock('./speed-button', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    SpeedSheet: ({ visible }: { visible: boolean }) => (visible ? <T>speed sheet</T> : null),
  };
});
jest.mock('./sleep-timer-button', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    SleepSheet: ({ visible }: { visible: boolean }) => (visible ? <T>sleep sheet</T> : null),
  };
});
jest.mock('./companion/chapters-panel', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { ChaptersPanel: () => <T>chapter list</T> };
});
jest.mock('./companion/companion', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { Companion: () => <T>companion</T> };
});
jest.mock('./grace-card', () => ({ GraceCard: () => null }));

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';
import { mountWithPortal } from '@/testing/render-overlay';

import { useCompanion } from './companion/companion-store';
import { PlayerSheetHost } from './player-sheet-host';
import { hostIsActive, usePlayerSheets } from './player-sheets';
/* eslint-enable import/first */

const open = (sheet: Parameters<ReturnType<typeof usePlayerSheets.getState>['openSheet']>[0]) =>
  act(() => usePlayerSheets.getState().openSheet(sheet));

beforeEach(() => {
  mockSegments = ['(app)'];
  usePlayerSheets.setState({ open: null });
  mockAddBookmark.mockClear();
});

describe('hostIsActive', () => {
  it('lets the shell host stand back while the full player is on top', () => {
    expect(hostIsActive('shell', false)).toBe(true);
    expect(hostIsActive('shell', true)).toBe(false);
    expect(hostIsActive('player', true)).toBe(true);
  });
});

describe('PlayerSheetHost', () => {
  it('renders the sheet asked for in the shell when the player is not open', async () => {
    await mountWithPortal(<PlayerSheetHost scope="shell" />);
    await open('speed');
    expect(screen.getByText('speed sheet')).toBeTruthy();
    await open('sleep');
    expect(screen.queryByText('speed sheet')).toBeNull();
    expect(screen.getByText('sleep sheet')).toBeTruthy();
  });

  it('opens a sheet only once with both hosts mounted: the player one, on top', async () => {
    mockSegments = ['player'];
    await mountWithPortal(
      <>
        <Text>shell:</Text>
        <PlayerSheetHost scope="shell" />
        <Text>player:</Text>
        <PlayerSheetHost scope="player" />
      </>,
    );
    await open('sleep');
    expect(screen.getAllByText('sleep sheet')).toHaveLength(1);
  });

  it('keeps the companion sheet to the full player', async () => {
    await mountWithPortal(<PlayerSheetHost scope="shell" />);
    await open('companion');
    expect(screen.queryByText('companion')).toBeNull();
  });

  it('shows the companion sheet in the full player', async () => {
    mockSegments = ['player'];
    await mountWithPortal(<PlayerSheetHost scope="player" />);
    await open('companion');
    expect(screen.getByText('companion')).toBeTruthy();
  });

  it('turns chapters into the companion tab where the player has a column', async () => {
    mockSegments = ['player'];
    await mountWithPortal(<PlayerSheetHost scope="player" chaptersInColumn />);
    await open('chapters');
    expect(screen.queryByText('chapter list')).toBeNull();
    expect(useCompanion.getState().tab).toBe('chapters');
    expect(usePlayerSheets.getState().open).toBeNull();
  });

  it('runs bookmark and output as actions, not sheets', async () => {
    await mountWithPortal(<PlayerSheetHost scope="shell" />);
    await open('bookmark');
    expect(mockAddBookmark).toHaveBeenCalledTimes(1);
    expect(usePlayerSheets.getState().open).toBeNull();
    await open('output');
    expect(usePlayer.getState().showRoutePicker).toHaveBeenCalledTimes(1);
  });

  it('closes its sheet when the full player goes away, so it does not reopen behind', async () => {
    mockSegments = ['player'];
    const view = await mountWithPortal(<PlayerSheetHost scope="player" />);
    await open('speed');
    await act(async () => view.unmount());
    expect(usePlayerSheets.getState().open).toBeNull();
  });

  it('leaves the keyboard overlay to the web shell', async () => {
    mockSegments = ['player'];
    const view = await mountWithPortal(<PlayerSheetHost scope="player" />);
    await open('shortcuts');
    await act(async () => view.unmount());
    expect(usePlayerSheets.getState().open).toBe('shortcuts');
  });
});
