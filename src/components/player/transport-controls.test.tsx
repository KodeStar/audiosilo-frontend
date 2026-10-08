import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, type AppStateStatus, StyleSheet } from 'react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

type MockPlayer = {
  nowPlaying: {
    queue: { total: number; chapters: { book_offset: number }[]; offsets: number[] };
  } | null;
  snapshot: { state: string; trackIndex: number; position: number };
  toggle: jest.Mock;
  retry: jest.Mock;
  skipSeconds: jest.Mock;
  seekBook: jest.Mock;
  seekInTrack: jest.Mock;
  goToTrack: jest.Mock;
};
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({})),
    selectIsPlaying: (s: MockPlayer) => s.snapshot.state === 'playing',
  };
});

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

import { PlayButton, TransportControls } from './transport-controls';
/* eslint-enable import/first */

const player = usePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;

beforeEach(() => {
  useSettings.setState({ skipForward: 30, skipBackward: 15 });
  player.setState({
    nowPlaying: {
      queue: { total: 3600, chapters: [{ book_offset: 0 }, { book_offset: 600 }], offsets: [0] },
    },
    snapshot: { state: 'paused', trackIndex: 0, position: 30 },
    toggle: jest.fn(),
    retry: jest.fn(),
    skipSeconds: jest.fn(),
    seekBook: jest.fn(),
    seekInTrack: jest.fn(),
    goToTrack: jest.fn(),
  });
});

const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

describe('TransportControls', () => {
  it('labels every control', async () => {
    await render(<TransportControls />);
    for (const name of [
      'Previous chapter',
      'Back 15 seconds',
      'Play',
      'Forward 30 seconds',
      'Next chapter',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('plays, skips and steps by chapter through the store', async () => {
    await render(<TransportControls size="lg" />);
    const s = player.getState();
    await press('Play');
    expect(s.toggle).toHaveBeenCalled();
    await press('Back 15 seconds');
    expect(s.skipSeconds).toHaveBeenLastCalledWith(-15);
    await press('Forward 30 seconds');
    expect(s.skipSeconds).toHaveBeenLastCalledWith(30);
    await press('Next chapter');
    expect(s.seekBook).toHaveBeenLastCalledWith(600);
    await press('Previous chapter');
    expect(s.seekBook).toHaveBeenLastCalledWith(0);
  });

  it('reads Pause while playing', async () => {
    await render(<TransportControls size="sm" />);
    await act(async () =>
      player.setState({ snapshot: { state: 'playing', trackIndex: 0, position: 30 } }),
    );
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('spins while loading', async () => {
    player.setState({ snapshot: { state: 'loading', trackIndex: 0, position: 0 } });
    await render(<TransportControls />);
    expect(screen.getByRole('button', { name: 'Play', busy: true })).toBeTruthy();
  });

  it('offers Retry when playback failed', async () => {
    player.setState({ snapshot: { state: 'error', trackIndex: 0, position: 0 } });
    await render(<TransportControls />);
    await press('Retry');
    expect(player.getState().retry).toHaveBeenCalled();
    expect(player.getState().toggle).not.toHaveBeenCalled();
  });

  it('follows the skip lengths setting', async () => {
    useSettings.setState({ skipForward: 45, skipBackward: 10 });
    await render(<TransportControls />);
    expect(screen.getByRole('button', { name: 'Back 10 seconds' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forward 45 seconds' })).toBeTruthy();
  });

  it('renders nothing with no book', async () => {
    player.setState({ nowPlaying: null });
    await render(<TransportControls />);
    expect(screen.toJSON()).toBeNull();
  });
});

describe('PlayButton plain', () => {
  it('draws no ink circle, keeps a 44 pt target, and still retries after an error', async () => {
    await render(<PlayButton size="sm" plain />);
    const button = screen.getByRole('button', { name: 'Play' });
    expect(button.props.className).not.toContain('bg-primary');
    // A 40 pt glyph box with 2 pt of slop on every side.
    expect(button).toHaveProp('hitSlop', 2);
    await act(async () =>
      player.setState({ snapshot: { state: 'error', trackIndex: 0, position: 0 } }),
    );
    await press('Retry');
    expect(player.getState().retry).toHaveBeenCalled();
  });

  it('is the ink circle by default', async () => {
    await render(<PlayButton size="sm" />);
    expect(screen.getByRole('button', { name: 'Play' }).props.className).toContain('bg-primary');
  });
});

describe('PlayButton glyph across the background', () => {
  // The device pass: a book paused from the shade while the app was away (then moved by
  // a pick-up) left the floating mini player drawing Pause for 20+ s after the app came
  // back, while the store and the full player said paused.
  let appState: AppStateStatus = 'active';
  let onChange: ((s: AppStateStatus) => void) | null = null;
  beforeEach(() => {
    appState = 'active';
    Object.defineProperty(AppState, 'currentState', {
      get: () => appState,
      configurable: true,
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (s: AppStateStatus) => void,
    ) => {
      onChange = handler;
      return { remove: () => {} };
    }) as unknown as typeof AppState.addEventListener);
  });
  afterEach(() => jest.restoreAllMocks());

  const opacity = (testID: string) =>
    StyleSheet.flatten(screen.getByTestId(testID, { includeHiddenElements: true }).props.style)
      .opacity;

  it('draws Play again when the app comes back after a pause in the background', async () => {
    player.setState({ snapshot: { state: 'playing', trackIndex: 0, position: 30 } });
    await render(<PlayButton size="sm" plain />);
    expect(opacity('pause-glyph')).toBe(1);
    const before = screen.getByTestId('play-pause-glyph', { includeHiddenElements: true });

    await act(async () => {
      appState = 'background';
      onChange?.('background');
      player.setState({ snapshot: { state: 'paused', trackIndex: 0, position: 30 } });
    });
    // The label follows the store at once; the glyph's drawn props are what went stale.
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();

    await act(async () => {
      appState = 'active';
      onChange?.('active');
    });
    const after = screen.getByTestId('play-pause-glyph', { includeHiddenElements: true });
    expect(after).not.toBe(before); // a fresh glyph, drawn from `playing`
    expect(opacity('play-glyph')).toBe(1);
    expect(opacity('pause-glyph')).toBe(0);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });
});
