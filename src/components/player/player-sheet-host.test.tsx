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
jest.mock('@/components/upnext/up-next-sheet', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    UpNextSheet: ({ visible }: { visible: boolean }) => (visible ? <T>up next sheet</T> : null),
  };
});

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';
import { mountWithPortal } from '@/testing/render-overlay';

import { useCompanion } from './companion/companion-store';
import { PlayerSheetHost } from './player-sheet-host';
import { hostIsActive, usePlayerSheets } from './player-sheets';
/* eslint-enable import/first */

const open = (sheet: Parameters<ReturnType<typeof usePlayerSheets.getState>['openSheet']>[0]) =>
  act(() => usePlayerSheets.getState().openSheet(sheet));

const BOOK = usePlayer.getState().nowPlaying;

beforeEach(() => {
  mockSegments = ['(app)'];
  usePlayerSheets.setState({ open: null });
  useCompanion.setState({ tab: null });
  usePlayer.setState({ nowPlaying: BOOK });
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
    await mountWithPortal(<PlayerSheetHost scope="player" layout="desktop" />);
    await open('chapters');
    expect(screen.queryByText('chapter list')).toBeNull();
    expect(screen.queryByText('companion')).toBeNull();
    expect(useCompanion.getState().tab).toBe('chapters');
    expect(usePlayerSheets.getState().open).toBeNull();
  });

  it("keeps one chapters UI on a phone player: the companion sheet's Chapters tab", async () => {
    mockSegments = ['player'];
    await mountWithPortal(<PlayerSheetHost scope="player" layout="phone" />);
    await open('chapters');
    expect(screen.getByText('companion')).toBeTruthy();
    expect(screen.queryByText('chapter list')).toBeNull();
    expect(useCompanion.getState().tab).toBe('chapters');
  });

  it('shows the chapter sheet in the tablet player and in the shell', async () => {
    mockSegments = ['player'];
    const view = await mountWithPortal(<PlayerSheetHost scope="player" layout="tablet" />);
    await open('chapters');
    expect(screen.getByText('chapter list')).toBeTruthy();
    await act(async () => view.unmount());
    mockSegments = ['(app)'];
    await mountWithPortal(<PlayerSheetHost scope="shell" />);
    await open('chapters');
    expect(screen.getByText('chapter list')).toBeTruthy();
  });

  it('opens the companion on a tab from one intent; wider players already show it', async () => {
    mockSegments = ['player'];
    await mountWithPortal(<PlayerSheetHost scope="player" layout="tablet" />);
    await act(() => usePlayerSheets.getState().openCompanion('who'));
    expect(useCompanion.getState().tab).toBe('who');
    expect(screen.queryByText('companion')).toBeNull();
    expect(usePlayerSheets.getState().open).toBeNull();
  });

  it('leaves a companion request in the shell for the full player it is opening', async () => {
    await mountWithPortal(<PlayerSheetHost scope="shell" />);
    await act(() => usePlayerSheets.getState().openCompanion('who'));
    expect(usePlayerSheets.getState().open).toBe('companion');
  });

  it('renders Up next with or without a book, once with both hosts mounted', async () => {
    usePlayer.setState({ nowPlaying: null });
    await mountWithPortal(<PlayerSheetHost scope="shell" />);
    await open('upnext');
    expect(screen.getByText('up next sheet')).toBeTruthy();
    await open('speed');
    expect(screen.queryByText('up next sheet')).toBeNull();
    expect(screen.queryByText('speed sheet')).toBeNull();
  });

  it('shows Up next over the full player from the player host only', async () => {
    mockSegments = ['player'];
    await mountWithPortal(
      <>
        <PlayerSheetHost scope="shell" />
        <PlayerSheetHost scope="player" layout="phone" />
      </>,
    );
    await open('upnext');
    expect(screen.getAllByText('up next sheet')).toHaveLength(1);
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
